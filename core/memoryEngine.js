/**
 * Horae v2 memory replay engine.
 *
 * This module intentionally has no SillyTavern runtime dependency. All enhanced
 * state is derived from the existing per-message horae_meta records, so legacy
 * chats, edits, deleted messages and alternate swipes rebuild deterministically.
 */

import { calculateRelativeTime, getActiveCustomCalendar, parseStoryDate } from '../utils/timeUtils.js';

const ACTIVE_AGENDA_STATUSES = new Set(['pending', 'in_progress', 'overdue']);
const CLOSED_ITEM_STATUSES = new Set([
    'consumed', 'depleted', 'lost', 'destroyed', 'transferred',
    'returned', 'expired', 'archived',
]);

function cleanText(value) {
    return String(value ?? '').trim();
}

function hashText(value) {
    // FNV-1a with Math.imul keeps IDs stable in every supported browser.
    let hash = 0x811c9dc5;
    const text = String(value ?? '');
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0');
}

/** Build a deterministic ID without mutating the source metadata. */
export function stableMemoryId(prefix, messageIndex, ordinal, content) {
    const cleanPrefix = cleanText(prefix).replace(/[^a-z0-9]/gi, '').toUpperCase() || 'M';
    return `${cleanPrefix}${hashText(`${messageIndex}|${ordinal}|${cleanText(content)}`)}`;
}

function parseNumericValue(raw) {
    const value = cleanText(raw);
    if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
    const fraction = value.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!fraction || Number(fraction[2]) === 0) return null;
    return Number(fraction[1]) / Number(fraction[2]);
}

/** Parse legacy names such as "苹果(5个)" while preserving non-quantity notes. */
export function parseLegacyQuantity(rawName) {
    const original = cleanText(rawName);
    const match = original.match(/^(.*?)[（(]\s*(\d+(?:\.\d+)?|\d+\s*\/\s*\d+)\s*([^\d（）()]*)[）)]\s*$/);
    if (!match) return { name: original, value: null, unit: '', raw: original };
    const value = parseNumericValue(match[2]);
    if (value === null) return { name: original, value: null, unit: '', raw: original };
    return {
        name: cleanText(match[1]) || original,
        value,
        unit: cleanText(match[3]),
        raw: original,
    };
}

function normalizeClockTime(raw) {
    const text = cleanText(raw);
    const match = text.match(/(?:^|[^\d])(\d{1,2})[:：](\d{2})(?=$|[^\d])/);
    if (!match) return { text, minutes: null };
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return { text, minutes: null };
    return {
        text: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        minutes: hour * 60 + minute,
    };
}

/** Normalize equivalent standard dates so 2026/2/4 and 2026-02-04 match. */
export function normalizeStoryDateKey(rawDate) {
    const raw = cleanText(rawDate);
    if (!raw) return '';
    const parsed = parseStoryDate(raw);
    if (!parsed) return `raw:${raw.replace(/\s+/g, '')}`;
    if (parsed.type === 'standard') {
        const prefix = cleanText(parsed.calendarPrefix);
        const year = parsed.year == null ? '?' : parsed.year;
        return `standard:${prefix}:${year}:${parsed.month}:${parsed.day}`;
    }
    if (parsed.type === 'custom') {
        const year = parsed.year == null ? '?' : parsed.year;
        return `custom:${year}:${parsed.monthIndex}:${parsed.day}`;
    }
    const month = cleanText(parsed.monthId || parsed.month || '');
    const day = parsed.day == null ? '' : parsed.day;
    return `fantasy:${month}:${day}:${raw.replace(/\s+/g, '')}`;
}

export function isSameStoryDate(left, right) {
    const a = cleanText(left);
    const b = cleanText(right);
    if (!a || !b) return false;
    if (normalizeStoryDateKey(a) === normalizeStoryDateKey(b)) return true;
    return calculateRelativeTime(a, b) === 0;
}

function storyDateSpecificity(rawDate) {
    const parsed = parseStoryDate(cleanText(rawDate));
    if (!parsed) return 0;
    let score = parsed.year == null ? 0 : 2;
    if (cleanText(parsed.calendarPrefix)) score += 1;
    return score;
}

// When the model alternates between 2026/2/4 and 2/4, keep the more
// informative representation so the clock and calendar do not lose a year.
function coalesceEquivalentStoryDate(currentDate, candidateDate) {
    const current = cleanText(currentDate);
    const candidate = cleanText(candidateDate);
    if (!candidate) return current;
    if (!current || !isSameStoryDate(current, candidate)) return candidate;
    return storyDateSpecificity(current) > storyDateSpecificity(candidate) ? current : candidate;
}

function calendarId(rawDate) {
    const parsed = parseStoryDate(cleanText(rawDate));
    if (!parsed) return 'unknown';
    if (parsed.type === 'standard') return cleanText(parsed.calendarPrefix) || 'standard';
    return parsed.type;
}

function dateTimeParts(raw) {
    const text = cleanText(raw);
    const match = text.match(/^(.*?)(?:\s+)(\d{1,2}[:：]\d{2})\s*$/);
    if (!match) return { date: text, time: '' };
    return { date: cleanText(match[1]), time: normalizeClockTime(match[2]).text };
}

function compareStoryDateTime(fromDate, fromTime, toDate, toTime) {
    if (!fromDate || !toDate) return null;
    const dayDiff = calculateRelativeTime(fromDate, toDate);
    if (dayDiff === null || dayDiff === -999) return null;
    if (dayDiff !== 0) return dayDiff * 1440;
    const fromMinutes = normalizeClockTime(fromTime).minutes;
    const toMinutes = normalizeClockTime(toTime).minutes;
    if (fromMinutes === null || toMinutes === null) return 0;
    return toMinutes - fromMinutes;
}

function isUsableMeta(message) {
    return !!message?.horae_meta && !message.horae_meta._skipHorae;
}

export function isFlashbackMeta(meta) {
    const timeline = cleanText(meta?.storyClock?.timeline || meta?.storyClock?.mode).toLowerCase();
    return timeline === 'flashback' || timeline === 'memory';
}

/**
 * Rebuild the authoritative main-story clock. Unexplained backward jumps are
 * reported and do not replace the last reliable clock value.
 */
export function buildStoryClock(chat, end = chat?.length || 0) {
    const limit = Math.max(0, Math.min(Number(end) || 0, chat?.length || 0));
    let currentDate = '';
    let currentTime = '';
    let elapsedMinutes = 0;
    let confidence = 'low';
    let source = 'inherited';
    let lastMessageIndex = -1;
    let anomaly = null;
    const anomalies = [];

    for (let i = 0; i < limit; i++) {
        if (!isUsableMeta(chat[i])) continue;
        const meta = chat[i].horae_meta;
        const hint = meta.storyClock && typeof meta.storyClock === 'object' ? meta.storyClock : {};
        if (isFlashbackMeta(meta)) continue;

        const candidateDate = cleanText(hint.rawDate || meta.timestamp?.story_date);
        const candidateTime = normalizeClockTime(hint.rawTime || meta.timestamp?.story_time).text;
        if (!candidateDate && !candidateTime) continue;

        const nextDate = coalesceEquivalentStoryDate(currentDate, candidateDate);
        const dateChanged = !!(currentDate && candidateDate && !isSameStoryDate(currentDate, candidateDate));
        // 同日缺时刻可继承上一个可靠时刻；跨日时不能把昨天的 16:00
        // 伪装成今天的 16:00。
        const nextTime = candidateTime || (dateChanged ? '' : currentTime);
        const delta = currentDate
            ? compareStoryDateTime(currentDate, currentTime, nextDate, nextTime)
            : 0;
        const allowBackward = hint.allowBackward === true || cleanText(hint.anomalyResolution) === 'accepted';

        if (delta !== null && delta < 0 && !allowBackward) {
            anomaly = {
                type: delta <= -1440 ? 'backward_date_jump' : 'backward_time_jump',
                messageIndex: i,
                previous: [currentDate, currentTime].filter(Boolean).join(' '),
                proposed: [nextDate, nextTime].filter(Boolean).join(' '),
                deltaMinutes: delta,
            };
            anomalies.push(anomaly);
            continue;
        }

        if (delta !== null && delta > 0) elapsedMinutes += delta;
        currentDate = nextDate;
        currentTime = nextTime;
        confidence = dateChanged && !candidateTime
            ? 'low'
            : (cleanText(hint.confidence) || (candidateTime ? 'medium' : 'low'));
        source = cleanText(hint.source) || (candidateDate ? 'metadata' : 'inherited');
        lastMessageIndex = i;
    }

    return {
        rawDate: currentDate,
        rawTime: currentTime,
        normalizedKey: normalizeStoryDateKey(currentDate),
        calendarId: calendarId(currentDate),
        elapsedMinutes,
        confidence,
        source,
        anomaly,
        anomalies,
        lastMessageIndex,
    };
}

/**
 * Build the accepted main-story frame for each usable message. A frame carries
 * the retained clock after anomaly handling, so calendar entries and the main
 * clock cannot disagree about where a message belongs.
 */
function buildMainStoryFrames(chat, end = chat?.length || 0) {
    const limit = Math.max(0, Math.min(Number(end) || 0, chat?.length || 0));
    const frames = [];
    let currentDate = '';
    let currentTime = '';

    for (let i = 0; i < limit; i++) {
        if (!isUsableMeta(chat[i])) continue;
        const meta = chat[i].horae_meta;
        if (isFlashbackMeta(meta)) continue;

        const hint = meta.storyClock && typeof meta.storyClock === 'object' ? meta.storyClock : {};
        const candidateDate = cleanText(hint.rawDate || meta.timestamp?.story_date);
        const candidateTime = normalizeClockTime(hint.rawTime || meta.timestamp?.story_time).text;
        let anomaly = null;

        if (candidateDate || candidateTime) {
            const nextDate = coalesceEquivalentStoryDate(currentDate, candidateDate);
            const dateChanged = !!(currentDate && candidateDate && !isSameStoryDate(currentDate, candidateDate));
            const nextTime = candidateTime || (dateChanged ? '' : currentTime);
            const delta = currentDate
                ? compareStoryDateTime(currentDate, currentTime, nextDate, nextTime)
                : 0;
            const allowBackward = hint.allowBackward === true || cleanText(hint.anomalyResolution) === 'accepted';

            if (delta !== null && delta < 0 && !allowBackward) {
                anomaly = {
                    type: delta <= -1440 ? 'backward_date_jump' : 'backward_time_jump',
                    messageIndex: i,
                    previous: [currentDate, currentTime].filter(Boolean).join(' '),
                    proposed: [nextDate, nextTime].filter(Boolean).join(' '),
                    deltaMinutes: delta,
                };
            } else {
                currentDate = nextDate;
                currentTime = nextTime;
            }
        }

        if (!currentDate) continue;
        frames.push({
            messageIndex: i,
            date: currentDate,
            time: currentTime,
            normalizedKey: normalizeStoryDateKey(currentDate),
            parsed: parseStoryDate(currentDate),
            anomaly,
            meta,
        });
    }

    return frames;
}

/** Return every meaningful non-summary event on the current story date. */
export function buildSameDayLedger(chat, end = chat?.length || 0, currentDate = '') {
    const limit = Math.max(0, Math.min(Number(end) || 0, chat?.length || 0));
    const targetDate = cleanText(currentDate) || buildStoryClock(chat, limit).rawDate;
    const targetKey = normalizeStoryDateKey(targetDate);
    if (!targetKey) return [];

    const ledger = [];
    const seen = new Set();
    let inheritedDate = '';
    let inheritedTime = '';

    for (let i = 0; i < limit; i++) {
        if (!isUsableMeta(chat[i])) continue;
        const meta = chat[i].horae_meta;
        // 闪回事件仍保留在原楼层和向量索引中，但不能混入当前主线的当日账本。
        if (isFlashbackMeta(meta)) continue;

        const hint = meta.storyClock && typeof meta.storyClock === 'object' ? meta.storyClock : {};
        const candidateDate = cleanText(hint.rawDate || meta.timestamp?.story_date);
        const candidateTime = normalizeClockTime(hint.rawTime || meta.timestamp?.story_time).text;
        if (candidateDate || candidateTime) {
            const nextDate = coalesceEquivalentStoryDate(inheritedDate, candidateDate);
            const dateChanged = !!(inheritedDate && candidateDate && !isSameStoryDate(inheritedDate, candidateDate));
            const nextTime = candidateTime || (dateChanged ? '' : inheritedTime);
            const delta = inheritedDate
                ? compareStoryDateTime(inheritedDate, inheritedTime, nextDate, nextTime)
                : 0;
            const allowBackward = hint.allowBackward === true || cleanText(hint.anomalyResolution) === 'accepted';
            // 与主时钟使用同一套规则。错误的倒退标签不能把本轮刚发生的
            // 事件从当前日期账本中挪走，也不能污染它的可靠时刻。
            if (delta === null || delta >= 0 || allowBackward) {
                inheritedDate = nextDate;
                inheritedTime = nextTime;
            }
        }
        if (normalizeStoryDateKey(inheritedDate) !== targetKey && !isSameStoryDate(inheritedDate, targetDate)) continue;

        const events = Array.isArray(meta.events)
            ? meta.events
            : (meta.event ? [meta.event] : []);
        for (let j = 0; j < events.length; j++) {
            const event = events[j];
            const summary = cleanText(event?.summary);
            if (!summary || event?.isSummary || event?.level === '摘要' || event?._summaryId) continue;
            const key = `${i}|${summary}`;
            if (seen.has(key)) continue;
            seen.add(key);
            ledger.push({
                id: stableMemoryId('E', i, j, summary),
                messageIndex: i,
                eventIndex: j,
                date: inheritedDate,
                time: inheritedTime,
                level: cleanText(event.level) || '一般',
                summary,
            });
        }
    }
    return ledger;
}

function splitProtocolParts(raw) {
    const parts = [];
    let current = '';
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (const char of cleanText(raw)) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (quote && char === '\\') {
            current += char;
            escaped = true;
            continue;
        }
        if (char === '"' || char === "'") {
            if (!quote) quote = char;
            else if (quote === char) quote = '';
            current += char;
            continue;
        }
        if (!quote) {
            if (char === '{' || char === '[') depth++;
            else if ((char === '}' || char === ']') && depth > 0) depth--;
            else if (char === '|' && depth === 0) {
                if (current.trim()) parts.push(current.trim());
                current = '';
                continue;
            }
        }
        current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function parseProtocolFields(raw) {
    const parts = splitProtocolParts(raw);
    const fields = {};
    if (parts.length > 0 && !parts[0].includes('=')) fields.id = normalizeProtocolId(parts.shift());
    for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const key = cleanText(part.slice(0, eq)).toLowerCase();
        fields[key] = cleanText(part.slice(eq + 1));
    }
    return fields;
}

function parseStructuredProtocolValue(value) {
    const text = cleanText(value);
    if (!text || !/^[{[]/.test(text)) return value;
    try {
        return JSON.parse(text);
    } catch {
        return value;
    }
}

function parseProtocolBoolean(value) {
    if (typeof value === 'boolean') return value;
    const normalized = cleanText(value).toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return value;
}

/** Parse one v2 item/agenda protocol line into a replayable transition. */
export function parseMemoryProtocolLine(line) {
    const match = cleanText(line).match(/^(item\+|item~|item>|itemx|agenda\+|agenda~|agenda!)[：:]\s*(.*)$/i);
    if (!match) return null;
    const prefix = match[1].toLowerCase();
    const fields = parseProtocolFields(match[2]);
    const aliases = {
        content: 'text', created: 'createdAt', createdat: 'createdAt',
        due: 'dueAt', dueat: 'dueAt', start: 'startAt', startat: 'startAt',
        end: 'endAt', endat: 'endAt', expires: 'expiresAt', expiresat: 'expiresAt',
        acquired: 'acquiredAt', acquiredat: 'acquiredAt',
        changed: 'lastChangedAt', lastchangedat: 'lastChangedAt',
        confirmed: 'lastConfirmedAt', lastconfirmedat: 'lastConfirmedAt',
        target: 'targetId', targetid: 'targetId', completionevidence: 'completionEvidence',
        decay: 'decayPolicy', decaypolicy: 'decayPolicy', owner: 'holder', place: 'location',
        quantity: 'qty', qty: 'qty', unit: 'unit', reason: 'reason', evidence: 'evidence',
        locked: '_locked', _locked: '_locked',
    };
    const record = {};
    for (const [key, rawValue] of Object.entries(fields)) {
        const canonicalKey = aliases[key] || key;
        let value = rawValue;
        if (['_locked'].includes(canonicalKey)) value = parseProtocolBoolean(value);
        if (['decayPolicy', 'recurrence', 'participants', 'qty'].includes(canonicalKey)) {
            value = parseStructuredProtocolValue(value);
        }
        record[canonicalKey] = value;
    }

    if (prefix === 'item+') record.action = 'add';
    else if (prefix === 'item~') record.action = 'update';
    else if (prefix === 'item>') record.action = 'transfer';
    else if (prefix === 'itemx') record.action = 'close';
    else if (prefix === 'agenda+') record.action = 'add';
    else if (prefix === 'agenda~') record.action = 'update';
    else if (prefix === 'agenda!') {
        record.action = 'close';
        if (!record.status) record.status = 'completed';
    }

    // 允许 itemx:钥匙 / agenda!:赴约 这样的直观写法。新增记录的首段
    // 是名称或内容；更新/关闭记录仍可把它同时作为目标 ID 或文本回退匹配。
    if (record.id && prefix.startsWith('item') && !record.name) {
        record.name = record.id;
        if (prefix === 'item+') delete record.id;
        else record.targetId = record.targetId || record.id;
    }
    if (record.id && prefix.startsWith('agenda') && !record.text && !record.title) {
        record.text = record.id;
        if (prefix === 'agenda+') delete record.id;
        else record.targetId = record.targetId || record.id;
    }

    if (record.qty !== undefined && (record.qty === null || typeof record.qty !== 'object')) {
        const qty = Number(record.qty);
        if (Number.isFinite(qty)) record.qty = qty;
        else delete record.qty;
    }
    if (record.delta !== undefined) {
        const delta = Number(record.delta);
        if (Number.isFinite(delta)) record.delta = delta;
        else delete record.delta;
    }
    return {
        kind: prefix.startsWith('item') ? 'item' : 'agenda',
        record,
    };
}

function normalizeStatus(raw, fallback) {
    return cleanText(raw).toLowerCase().replace(/\s+/g, '_') || fallback;
}

function normalizeProtocolId(raw) {
    return cleanText(raw).replace(/^#/, '');
}

function agendaTextMatches(left, right) {
    const a = cleanText(left);
    const b = cleanText(right);
    return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

function inferExplicitDueAt(text, createdAt) {
    const value = cleanText(text);
    const absolute = value.match(/((?:\d{4}[\/\-.])?\d{1,2}[\/\-.]\d{1,2})\s*(\d{1,2}[:：]\d{2})?/);
    if (absolute) return [absolute[1], normalizeClockTime(absolute[2]).text].filter(Boolean).join(' ');
    const cn = value.match(/((?:\d+年)?\d{1,2}月\d{1,2}日)\s*(\d{1,2}[:：]\d{2})?/);
    if (cn) return [cn[1], normalizeClockTime(cn[2]).text].filter(Boolean).join(' ');
    const sameDay = value.match(/(?:今天|今日|当日|當日|今晚|今夜)[^\d]{0,8}(\d{1,2}[:：]\d{2})/);
    if (sameDay && createdAt) {
        const created = dateTimeParts(createdAt);
        return `${created.date} ${normalizeClockTime(sameDay[1]).text}`.trim();
    }
    return '';
}

export function normalizeLegacyAgenda(item, messageIndex, ordinal, timestamp = {}) {
    const source = item && typeof item === 'object' ? item : { text: item };
    const text = cleanText(source.text || source.title || source.content);
    const createdAt = cleanText(source.createdAt || source.date || timestamp.story_date);
    const dueAt = cleanText(source.dueAt) || inferExplicitDueAt(text, createdAt);
    const id = normalizeProtocolId(source.id) || stableMemoryId('A', messageIndex, ordinal, text);
    return {
        ...source,
        id,
        title: cleanText(source.title) || text,
        text,
        date: cleanText(source.date) || createdAt,
        createdAt,
        dueAt,
        startAt: cleanText(source.startAt),
        endAt: cleanText(source.endAt),
        expiresAt: cleanText(source.expiresAt),
        status: source.done ? 'completed' : normalizeStatus(source.status, 'pending'),
        participants: Array.isArray(source.participants) ? [...source.participants] : [],
        location: cleanText(source.location),
        priority: cleanText(source.priority),
        recurrence: source.recurrence || null,
        completionEvidence: cleanText(source.completionEvidence),
        supersedes: normalizeProtocolId(source.supersedes),
        lastChangedAt: cleanText(source.lastChangedAt) || createdAt,
        source: source.source || (messageIndex === 0 ? 'user' : 'ai'),
        _store: messageIndex === 0 ? 'user' : 'msg',
        _msgIndex: messageIndex,
        _index: ordinal,
        history: Array.isArray(source.history) ? [...source.history] : [],
    };
}

function findAgenda(items, transition) {
    const id = normalizeProtocolId(transition.id || transition.targetId);
    if (id && items.has(id)) return items.get(id);
    const text = cleanText(transition.text || transition.title || transition.content);
    if (!text) return null;
    const candidates = [...items.values()].reverse();
    return candidates.find(item => agendaTextMatches(item.text, text)) || null;
}

function applyAgendaTransition(items, transition, messageIndex, ordinal, timestamp) {
    const action = normalizeStatus(transition.action || transition.op, 'update');
    if (action === 'add' || action === 'create' || action === '+') {
        const normalized = normalizeLegacyAgenda(transition, messageIndex, ordinal, timestamp);
        if (!normalized.text) return;
        const explicitId = normalizeProtocolId(transition.id);
        const duplicate = explicitId ? (items.get(explicitId) || null) : findAgenda(items, normalized);
        if (!duplicate) {
            items.set(normalized.id, normalized);
            return;
        }
        // agenda+ 同时写入旧 agenda 投影时，先读到的兼容记录可能只含
        // text/dueAt。把生命周期记录中的增强字段补回同一计划。
        for (const field of ['title', 'date', 'createdAt', 'dueAt', 'startAt', 'endAt', 'expiresAt', 'participants', 'location', 'priority', 'recurrence', 'completionEvidence', 'supersedes']) {
            if (normalized[field] !== undefined && normalized[field] !== '' && normalized[field] !== null) {
                duplicate[field] = normalized[field];
            }
        }
        const before = duplicate.status;
        duplicate.status = normalized.status;
        duplicate.done = !ACTIVE_AGENDA_STATUSES.has(duplicate.status);
        duplicate.history.push({ messageIndex, action: 'merge-add', from: before, to: duplicate.status });
        return;
    }
    const target = findAgenda(items, transition);
    if (!target) return;
    const before = target.status;
    for (const field of ['title', 'text', 'date', 'createdAt', 'dueAt', 'startAt', 'endAt', 'expiresAt', 'participants', 'location', 'priority', 'recurrence', 'completionEvidence', 'supersedes']) {
        if (transition[field] !== undefined && transition[field] !== '') target[field] = transition[field];
    }
    target.status = normalizeStatus(transition.status, action === 'close' ? 'completed' : target.status);
    target.done = !ACTIVE_AGENDA_STATUSES.has(target.status);
    const transitionAt = cleanText(transition.lastChangedAt) || [timestamp.story_date, timestamp.story_time].filter(Boolean).join(' ');
    if (transitionAt) target.lastChangedAt = transitionAt;
    target.history.push({ messageIndex, action, from: before, to: target.status, evidence: cleanText(transition.evidence || transition.reason) });
}

function markAgendaByText(items, text, status, messageIndex, timestamp) {
    const target = findAgenda(items, { text });
    if (!target) return;
    const before = target.status;
    target.status = status;
    target.done = true;
    const transitionAt = [timestamp.story_date, timestamp.story_time].filter(Boolean).join(' ');
    if (transitionAt) target.lastChangedAt = transitionAt;
    target.history.push({ messageIndex, action: 'legacy-close', from: before, to: status });
}

function isPastDue(dueAt, clock) {
    const due = dateTimeParts(dueAt);
    if (!due.date || !clock?.rawDate) return false;
    const delta = compareStoryDateTime(due.date, due.time, clock.rawDate, clock.rawTime);
    return delta !== null && delta > 0;
}

/** Replay both legacy agenda arrays and v2 lifecycle transitions. */
export function replayAgendaLifecycle(chat, end = chat?.length || 0, options = {}) {
    const limit = Math.max(0, Math.min(Number(end) || 0, chat?.length || 0));
    const items = new Map();

    for (let i = 0; i < limit; i++) {
        if (!isUsableMeta(chat[i])) continue;
        const meta = chat[i].horae_meta;
        if (isFlashbackMeta(meta)) continue;
        const timestamp = meta.timestamp || {};
        for (let j = 0; j < (meta.agenda || []).length; j++) {
            const normalized = normalizeLegacyAgenda(meta.agenda[j], i, j, timestamp);
            if (!normalized.text) continue;
            const explicitId = normalizeProtocolId(meta.agenda[j]?.id);
            const duplicate = explicitId ? (items.get(explicitId) || null) : findAgenda(items, normalized);
            if (!duplicate) items.set(normalized.id, normalized);
        }
        for (let j = 0; j < (meta.agendaLifecycle || []).length; j++) {
            applyAgendaTransition(items, meta.agendaLifecycle[j], i, j, timestamp);
        }
        for (const text of (meta.deletedAgenda || [])) {
            markAgendaByText(items, text, 'completed', i, timestamp);
        }
    }

    const userDeleted = chat?.[0]?.horae_meta?._deletedAgendaTexts || [];
    for (const text of userDeleted) markAgendaByText(items, text, 'archived', 0, {});
    const userOverrides = chat?.[0]?.horae_meta?._agendaOverrides || [];
    for (let i = 0; i < userOverrides.length; i++) {
        applyAgendaTransition(items, userOverrides[i], 0, i, {});
    }
    const userDeletedIds = chat?.[0]?.horae_meta?._deletedAgendaIds || [];
    for (const id of userDeletedIds) {
        applyAgendaTransition(items, { action: 'close', targetId: id, status: 'archived' }, 0, 0, {});
    }

    const clock = options.clock || buildStoryClock(chat, limit);
    for (const item of items.values()) {
        const inactiveAt = item.expiresAt || item.endAt;
        if (ACTIVE_AGENDA_STATUSES.has(item.status) && inactiveAt && isPastDue(inactiveAt, clock)) {
            item.history.push({ messageIndex: clock.lastMessageIndex, action: 'clock', from: item.status, to: 'expired' });
            item.status = 'expired';
        }
        if ((item.status === 'pending' || item.status === 'in_progress') && isPastDue(item.dueAt, clock)) {
            item.history.push({ messageIndex: clock.lastMessageIndex, action: 'clock', from: item.status, to: 'overdue' });
            item.status = 'overdue';
        }
        item.done = !ACTIVE_AGENDA_STATUSES.has(item.status);
    }

    const all = [...items.values()];
    return {
        all,
        active: all.filter(item => ACTIVE_AGENDA_STATUSES.has(item.status) && !item._deleted),
        archived: all.filter(item => !ACTIVE_AGENDA_STATUSES.has(item.status) || item._deleted),
    };
}

function itemBaseKey(value) {
    return parseLegacyQuantity(value).name.toLocaleLowerCase();
}

function parsePerDayDecay(policy) {
    if (!policy) return 0;
    let value = policy;
    if (typeof value === 'string' && value.trim().startsWith('{')) {
        try { value = JSON.parse(value); } catch { /* keep string fallback */ }
    }
    if (value && typeof value === 'object') {
        const type = normalizeStatus(value.type || value.mode, '');
        const amount = Number(value.amount ?? value.perDay ?? value.rate);
        return (type === 'per_day' || type === 'daily') && Number.isFinite(amount) && amount > 0 ? amount : 0;
    }
    const match = cleanText(value).match(/^(?:per[_-]?day|daily)\s*[:=]\s*(\d+(?:\.\d+)?)$/i);
    return match ? Number(match[1]) : 0;
}

function applyItemDecay(item, atDateTime, messageIndex) {
    const amountPerDay = parsePerDayDecay(item?.decayPolicy);
    if (!amountPerDay || item?.quantity?.value === null || item?.quantity?.value === undefined) return;
    const fromDate = dateTimeParts(item.lastChangedAt || item.acquiredAt).date;
    const toDate = dateTimeParts(atDateTime).date;
    if (!fromDate || !toDate) return;
    const days = calculateRelativeTime(fromDate, toDate);
    if (!Number.isFinite(days) || days <= 0 || days === -999) return;
    const before = item.quantity.value;
    item.quantity.value = Math.max(0, before - amountPerDay * days);
    item.lastChangedAt = atDateTime;
    if (item.quantity.value === 0 && item.status === 'active') item.status = 'depleted';
    item.history.push({ messageIndex, action: 'decay', days, quantityBefore: before, quantityAfter: item.quantity.value });
}

function inferLegacyItemStatus(name, info) {
    const text = `${name} ${cleanText(info?.holder)} ${cleanText(info?.status)}`;
    if (/[（(](?:已消耗|已用完|消耗殆尽|消耗殆盡|consumed|used\s*up)[）)]/i.test(text)) return 'consumed';
    if (/[（(](?:已销毁|已銷毀|destroyed)[）)]/i.test(text)) return 'destroyed';
    if (/^(?:无|無|none|depleted)$/i.test(cleanText(info?.holder))) return 'depleted';
    return normalizeStatus(info?.status, 'active');
}

export function normalizeLegacyItem(rawName, info, messageIndex, ordinal, timestamp = {}) {
    const source = info && typeof info === 'object' ? info : {};
    const parsed = parseLegacyQuantity(rawName || source.name);
    const name = cleanText(source.name) || parsed.name;
    const id = normalizeProtocolId(source.id || source._id) || stableMemoryId('I', messageIndex, ordinal, name);
    const quantitySource = source.quantity ?? source.qty;
    const quantityValue = quantitySource && typeof quantitySource === 'object'
        ? quantitySource.value
        : (quantitySource ?? parsed.value);
    const quantityUnit = quantitySource && typeof quantitySource === 'object'
        ? quantitySource.unit
        : (source.unit || parsed.unit);
    const changedAt = [timestamp.story_date, timestamp.story_time].filter(Boolean).join(' ');
    const numericQuantity = quantityValue == null ? null : Number(quantityValue);
    return {
        ...source,
        id,
        _id: cleanText(source._id) || id,
        name,
        displayName: parsed.raw || name,
        aliases: Array.isArray(source.aliases) ? [...source.aliases] : [],
        kind: cleanText(source.kind) || 'unspecified',
        quantity: { value: Number.isFinite(numericQuantity) ? numericQuantity : null, unit: cleanText(quantityUnit) },
        status: inferLegacyItemStatus(rawName, source),
        holder: source.holder ?? null,
        location: cleanText(source.location),
        acquiredAt: cleanText(source.acquiredAt) || changedAt,
        lastChangedAt: cleanText(source.lastChangedAt) || changedAt,
        expiresAt: cleanText(source.expiresAt),
        lastConfirmedAt: cleanText(source.lastConfirmedAt) || changedAt,
        importance: cleanText(source.importance),
        decayPolicy: source.decayPolicy || null,
        history: Array.isArray(source.history) ? [...source.history] : [],
    };
}

function findItem(items, transition) {
    const id = normalizeProtocolId(transition.id || transition.targetId || transition._id);
    if (id && items.has(id)) return items.get(id);
    const name = cleanText(transition.name || transition.text || transition.item);
    if (!name) return null;
    const key = itemBaseKey(name);
    const candidates = [...items.values()].reverse();
    return candidates.find(item => itemBaseKey(item.name) === key || item.aliases.some(alias => itemBaseKey(alias) === key)) || null;
}

function applyItemSnapshot(items, rawName, info, messageIndex, ordinal, timestamp, options = {}) {
    const { allowRevive = false } = options;
    const normalized = normalizeLegacyItem(rawName, info, messageIndex, ordinal, timestamp);
    const explicitId = normalizeProtocolId(info?.id || info?._id);
    // An explicit ID is an identity claim. Falling back to the display name here
    // would collapse two distinct same-name objects into one inventory record.
    let target = explicitId ? (items.get(explicitId) || null) : findItem(items, normalized);
    if (!target) {
        items.set(normalized.id, normalized);
        target = normalized;
    } else {
        const wasClosed = CLOSED_ITEM_STATUSES.has(target.status);
        if (wasClosed && !allowRevive) {
            target.aliases = [...new Set([
                ...target.aliases,
                ...(normalized.aliases || []),
                normalized.name,
            ].filter(name => name && name !== target.name))];
            target.history.push({
                messageIndex,
                action: 'ignored-legacy-snapshot',
                status: target.status,
                proposedStatus: normalized.status,
            });
            return;
        }

        applyItemDecay(target, normalized.lastChangedAt, messageIndex);
        const oldName = target.name;
        target.aliases = [...new Set([...target.aliases, ...(normalized.aliases || []), oldName].filter(name => name && name !== normalized.name))];
        for (const field of ['name', 'displayName', 'icon', 'holder', 'location', 'description', 'kind', 'importance', 'expiresAt', 'decayPolicy', '_locked']) {
            if (normalized[field] !== undefined && normalized[field] !== '' && normalized[field] !== null) target[field] = normalized[field];
        }
        if (normalized.quantity.value !== null) target.quantity = normalized.quantity;
        else if (wasClosed && target.quantity.value === 0) {
            target.quantity = { value: null, unit: normalized.quantity.unit || target.quantity.unit };
        }
        target.status = normalized.status;
        if (wasClosed && normalized.acquiredAt) target.acquiredAt = normalized.acquiredAt;
        target.lastChangedAt = normalized.lastChangedAt;
        target.lastConfirmedAt = normalized.lastConfirmedAt;
    }
    if (target.quantity.value === 0 && target.status === 'active') target.status = 'depleted';
    target.history.push({ messageIndex, action: 'legacy-snapshot', status: target.status, quantity: target.quantity.value });
}

function closeItem(items, transition, messageIndex, timestamp, fallbackStatus = 'consumed') {
    const target = findItem(items, transition);
    if (!target) return;
    applyItemDecay(target, [timestamp.story_date, timestamp.story_time].filter(Boolean).join(' '), messageIndex);
    const before = target.status;
    target.status = normalizeStatus(transition.status, fallbackStatus);
    if (target.status === 'depleted' || target.status === 'consumed') {
        if (target.quantity.value !== null) target.quantity.value = 0;
    }
    const transitionAt = cleanText(transition.lastChangedAt) || [timestamp.story_date, timestamp.story_time].filter(Boolean).join(' ');
    if (transitionAt) target.lastChangedAt = transitionAt;
    target.history.push({ messageIndex, action: 'close', from: before, to: target.status, reason: cleanText(transition.reason) });
}

function applyItemTransition(items, transition, messageIndex, ordinal, timestamp) {
    const action = normalizeStatus(transition.action || transition.op, 'update');
    if (action === 'add' || action === 'create' || action === '+') {
        applyItemSnapshot(items, transition.name || transition.text, transition, messageIndex, ordinal, timestamp, { allowRevive: true });
        return;
    }
    if (action === 'close' || action === 'remove' || action === 'x') {
        closeItem(items, transition, messageIndex, timestamp);
        return;
    }
    const target = findItem(items, transition);
    if (!target) return;
    applyItemDecay(target, [timestamp.story_date, timestamp.story_time].filter(Boolean).join(' '), messageIndex);
    const beforeQuantity = target.quantity.value;
    if (transition.delta !== undefined && transition.delta !== '') {
        const delta = Number(transition.delta);
        if (Number.isFinite(delta)) target.quantity.value = (target.quantity.value ?? 0) + delta;
    }
    if (transition.qty !== undefined || transition.quantity !== undefined) {
        const raw = transition.qty ?? transition.quantity;
        const value = raw && typeof raw === 'object' ? raw.value : Number(raw);
        const unit = raw && typeof raw === 'object' ? raw.unit : transition.unit;
        if (value !== null && Number.isFinite(Number(value))) target.quantity.value = Number(value);
        if (unit !== undefined) target.quantity.unit = cleanText(unit);
    }
    for (const field of ['icon', 'holder', 'location', 'description', 'kind', 'importance', 'expiresAt', 'decayPolicy', '_locked']) {
        if (transition[field] !== undefined) target[field] = transition[field];
    }
    if (transition.name && transition.name !== target.name) {
        target.aliases = [...new Set([...target.aliases, target.name])];
        target.name = transition.name;
    }
    if (transition.status) target.status = normalizeStatus(transition.status, target.status);
    if (target.quantity.value !== null && target.quantity.value <= 0 && target.status === 'active') {
        target.quantity.value = 0;
        target.status = 'depleted';
    }
    const transitionAt = cleanText(transition.lastChangedAt) || [timestamp.story_date, timestamp.story_time].filter(Boolean).join(' ');
    if (transitionAt) target.lastChangedAt = transitionAt;
    const confirmedAt = cleanText(transition.lastConfirmedAt) || transitionAt;
    if (confirmedAt) target.lastConfirmedAt = confirmedAt;
    target.history.push({ messageIndex, action, quantityBefore: beforeQuantity, quantityAfter: target.quantity.value, reason: cleanText(transition.reason) });
}

function itemHasKnownExpiry(item) {
    return !!cleanText(item.expiresAt) || !!item.decayPolicy;
}

/** Replay legacy item snapshots plus v2 quantity/transfer/closure transitions. */
export function replayItemLifecycle(chat, end = chat?.length || 0, options = {}) {
    const limit = Math.max(0, Math.min(Number(end) || 0, chat?.length || 0));
    const items = new Map();

    for (let i = 0; i < limit; i++) {
        if (!isUsableMeta(chat[i])) continue;
        const meta = chat[i].horae_meta;
        if (isFlashbackMeta(meta)) continue;
        const timestamp = meta.timestamp || {};
        let ordinal = 0;
        for (const [name, info] of Object.entries(meta.items || {})) {
            applyItemSnapshot(items, name, info, i, ordinal++, timestamp);
        }
        for (let j = 0; j < (meta.itemLifecycle || []).length; j++) {
            applyItemTransition(items, meta.itemLifecycle[j], i, j, timestamp);
        }
        for (const name of (meta.deletedItems || [])) {
            closeItem(items, { name }, i, timestamp, 'consumed');
        }
    }

    // Panel edits and archives are a chat-level overlay. They deliberately run
    // after source replay so old Horae metadata stays importable and untouched.
    const userOverrides = chat?.[0]?.horae_meta?._itemOverrides || [];
    for (let i = 0; i < userOverrides.length; i++) {
        applyItemTransition(items, userOverrides[i], 0, i, {});
    }
    const userDeletedIds = chat?.[0]?.horae_meta?._deletedItemIds || [];
    for (const id of userDeletedIds) {
        closeItem(items, { targetId: id, status: 'archived', reason: 'user-panel' }, 0, {}, 'archived');
    }

    const clock = options.clock || buildStoryClock(chat, limit);
    for (const item of items.values()) {
        applyItemDecay(item, [clock.rawDate, clock.rawTime].filter(Boolean).join(' '), clock.lastMessageIndex);
        if (item.status !== 'active' || !itemHasKnownExpiry(item) || !item.expiresAt) continue;
        if (isPastDue(item.expiresAt, clock)) {
            item.history.push({ messageIndex: clock.lastMessageIndex, action: 'clock', from: item.status, to: 'expired' });
            item.status = 'expired';
        }
    }

    const all = [...items.values()];
    return {
        all,
        active: all.filter(item => !CLOSED_ITEM_STATUSES.has(item.status)),
        archived: all.filter(item => CLOSED_ITEM_STATUSES.has(item.status)),
    };
}

function lifecycleDateKey(rawDateTime) {
    return normalizeStoryDateKey(dateTimeParts(rawDateTime).date);
}

function describeAgendaChange(record, messageIndex, ordinal, fallbackAction = 'update') {
    const text = cleanText(record?.text || record?.title || record?.content);
    return {
        id: normalizeProtocolId(record?.id || record?.targetId) || stableMemoryId('AC', messageIndex, ordinal, text),
        action: normalizeStatus(record?.action || record?.op, fallbackAction),
        text,
        status: normalizeStatus(record?.status, ''),
        dueAt: cleanText(record?.dueAt || record?.due),
        expiresAt: cleanText(record?.expiresAt || record?.endAt),
        messageIndex,
    };
}

function describeItemChange(record, messageIndex, ordinal, fallbackAction = 'update') {
    const name = cleanText(record?.name || record?.text || record?.item);
    return {
        id: normalizeProtocolId(record?.id || record?.targetId || record?._id) || stableMemoryId('IC', messageIndex, ordinal, name),
        action: normalizeStatus(record?.action || record?.op, fallbackAction),
        name,
        status: normalizeStatus(record?.status, ''),
        quantity: record?.qty ?? record?.quantity ?? null,
        delta: record?.delta ?? null,
        unit: cleanText(record?.unit),
        holder: record?.holder ?? null,
        location: cleanText(record?.location),
        expiresAt: cleanText(record?.expiresAt),
        decayPolicy: record?.decayPolicy || null,
        reason: cleanText(record?.reason || record?.evidence),
        messageIndex,
    };
}

/** Calendar-only summary detection. Timeline data remains untouched. */
export function isCalendarSummaryEvent(event, knownSummaryTexts = null) {
    if (!event || typeof event !== 'object') return false;
    if (event.isSummary || event._summaryId || event._carryoverSeed) return true;
    const level = cleanText(event.level).toLowerCase().replace(/\s+/g, '');
    if (/^(?:摘要|总结|總結|summary|要約|요약|конспект)(?:l?\d+)?/iu.test(level)
        || /^(?:回顾|回顧|recap|振り返り|회고|обзор)$/iu.test(level)) return true;
    const normalizedSummary = normalizeCalendarSummaryReference(event.summary);
    if (!normalizedSummary || !knownSummaryTexts?.size) return false;
    if (knownSummaryTexts.has(normalizedSummary)) return true;
    return [...knownSummaryTexts].some(known => areSimilarCalendarEvents(normalizedSummary, known));
}

function calendarEventPriority(event) {
    const level = cleanText(event?.level).toLowerCase();
    if (/(?:关键|關鍵|critical|핵심|重大|ключ)/iu.test(level)) return 3;
    if (event?.is_important || /(?:重要|important|중요|важ)/iu.test(level)) return 2;
    return 1;
}

function normalizeCalendarEventText(value) {
    return cleanText(value)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function normalizeCalendarSummaryReference(value) {
    return normalizeCalendarEventText(value).replace(
        /^(?:(?:剧情|劇情|故事|事件|本段|本次|阶段|階段|章节|章節|今日|当日|當日|story|event|chapter)?(?:摘要|总结|總結|summary|要約|요약|конспект|回顾|回顧|recap)(?:l?\d+)?(?:内容|內容)?)/iu,
        '',
    );
}

function areSimilarCalendarEvents(left, right) {
    const a = normalizeCalendarEventText(left);
    const b = normalizeCalendarEventText(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length > b.length ? a : b;
    return shorter.length >= 12 && longer.includes(shorter) && shorter.length / longer.length >= 0.82;
}

function addCalendarEvent(day, candidate) {
    const duplicateIndex = day.events.findIndex(existing =>
        areSimilarCalendarEvents(existing.summary, candidate.summary)
    );
    if (duplicateIndex < 0) {
        day.events.push(candidate);
        return;
    }

    const existing = day.events[duplicateIndex];
    const candidateWins = candidate.priorityRank > existing.priorityRank
        || (candidate.priorityRank === existing.priorityRank && candidate.summary.length > existing.summary.length);
    if (candidateWins) day.events[duplicateIndex] = candidate;
}

function finalizeCalendarEvents(day, previewLimit = 3) {
    const chronological = [...day.events].sort((a, b) =>
        a.messageIndex - b.messageIndex || a.eventIndex - b.eventIndex
    );
    const ranked = [...chronological].sort((a, b) =>
        b.priorityRank - a.priorityRank
        || a.messageIndex - b.messageIndex
        || a.eventIndex - b.eventIndex
    );
    const important = ranked.filter(event => event.priorityRank >= 2);
    const normal = ranked.filter(event => event.priorityRank < 2);
    const featured = important.slice(0, previewLimit);
    if (featured.length < 3) {
        featured.push(...normal.slice(0, Math.min(3 - featured.length, previewLimit - featured.length)));
    }
    const featuredIds = new Set(featured.map(event => event.id));

    day.events = chronological;
    day.featuredEvents = featured;
    day.otherEvents = ranked.filter(event => !featuredIds.has(event.id));
}

export function collectActiveSummaryCoverage(chat) {
    const ids = new Set();
    const messageIndices = new Set();
    const summaryTexts = new Set();
    const summaries = chat?.[0]?.horae_meta?.autoSummaries;
    if (!Array.isArray(summaries)) return { ids, messageIndices, summaryTexts };

    for (const summary of summaries) {
        if (!summary || summary.active === false) continue;
        if (summary.id) ids.add(String(summary.id));
        for (const text of [summary.summaryText, summary.summary, summary.title]) {
            const normalized = normalizeCalendarSummaryReference(text);
            if (normalized) summaryTexts.add(normalized);
        }
        if (Array.isArray(summary.coveredIndices) && summary.coveredIndices.length > 0) {
            for (const index of summary.coveredIndices) {
                if (Number.isInteger(index) && index >= 0) messageIndices.add(index);
            }
        } else if (Array.isArray(summary.range) && summary.range.length >= 2) {
            const start = Math.max(0, Number(summary.range[0]) || 0);
            const end = Math.max(start, Number(summary.range[1]) || start);
            for (let index = start; index <= end; index++) messageIndices.add(index);
        }
    }
    return { ids, messageIndices, summaryTexts };
}

function collectCalendarSummaryTexts(chat) {
    const texts = new Set();
    const summaries = chat?.[0]?.horae_meta?.autoSummaries;
    if (!Array.isArray(summaries)) return texts;
    for (const summary of summaries) {
        if (!summary || typeof summary !== 'object') continue;
        for (const text of [summary.summaryText, summary.summary, summary.title]) {
            const normalized = normalizeCalendarSummaryReference(text);
            if (normalized) texts.add(normalized);
        }
    }
    return texts;
}

/** Runtime-only check used by calendar and timeline views for legacy summaries. */
export function isOriginalEventCoveredByActiveSummary(event, messageIndex, coverage) {
    if (!event || isCalendarSummaryEvent(event, coverage?.summaryTexts)) return false;
    const compressedBy = cleanText(event._compressedBy);
    return !!(compressedBy && coverage?.ids?.has(compressedBy))
        || coverage?.messageIndices?.has(messageIndex) === true;
}

/**
 * Build a narrative calendar from accepted main-story metadata. It never reads
 * the computer clock and never mutates story state. Unknown fantasy dates stay
 * as an ordered list instead of being invented into a numeric calendar.
 */
export function buildStoryCalendar(chat, end = chat?.length || 0, options = {}) {
    const limit = Math.max(0, Math.min(Number(end) || 0, chat?.length || 0));
    const clock = options.clock || buildStoryClock(chat, limit);
    const frames = buildMainStoryFrames(chat, limit);
    const days = new Map();
    const seenLegacyAgenda = new Set();
    const seenLegacyItems = new Set();
    const calendarSummaryTexts = collectCalendarSummaryTexts(chat);
    const frameByMessageIndex = new Map(frames.map(frame => [frame.messageIndex, frame]));
    const relationshipState = new Map();
    let previousLocation = '';

    const findEquivalentDay = (rawDate, parsed) => {
        const candidates = [...days.values()].filter(day => isSameStoryDate(day.date, rawDate));
        if (!candidates.length) return null;
        const year = parsed?.year ?? null;
        if (year !== null) {
            const exactYear = candidates.find(day => day.year === year);
            if (exactYear) return exactYear;
            const yearless = candidates.filter(day => day.year === null);
            return yearless.length === 1 ? yearless[0] : null;
        }
        const yearless = candidates.find(day => day.year === null);
        if (yearless) return yearless;
        const years = new Set(candidates.map(day => day.year).filter(value => value !== null));
        return years.size === 1 ? candidates[0] : null;
    };

    const ensureDay = (frame) => {
        let day = days.get(frame.normalizedKey) || findEquivalentDay(frame.date, frame.parsed);
        if (day) {
            const incomingYear = frame.parsed?.year ?? null;
            if (day.year === null && incomingYear !== null) {
                days.delete(day.key);
                day.key = frame.normalizedKey;
                day.date = frame.date;
                day.displayDate = frame.date;
                day.year = incomingYear;
                day.calendarPrefix = cleanText(frame.parsed?.calendarPrefix);
                days.set(day.key, day);
            }
            if (frame.normalizedKey === clock.normalizedKey) day.current = true;
            return day;
        }
        const parsed = frame.parsed;
        day = {
            key: frame.normalizedKey,
            date: frame.date,
            displayDate: frame.date,
            calendarType: parsed?.type || 'unknown',
            calendarPrefix: cleanText(parsed?.calendarPrefix),
            year: parsed?.year ?? null,
            month: parsed?.month ?? null,
            monthIndex: parsed?.monthIndex ?? null,
            monthId: cleanText(parsed?.monthId || parsed?.month),
            day: parsed?.day ?? null,
            messageIndices: [],
            firstTime: '',
            lastTime: '',
            events: [],
            featuredEvents: [],
            otherEvents: [],
            agendaChanges: [],
            agendaDue: [],
            itemChanges: [],
            locationChanges: [],
            relationshipChanges: [],
            anomalies: [],
            current: frame.normalizedKey === clock.normalizedKey,
        };
        days.set(frame.normalizedKey, day);
        return day;
    };

    const ensureDateDay = (rawDateTime) => {
        const parts = dateTimeParts(rawDateTime);
        const key = normalizeStoryDateKey(parts.date);
        if (!key) return null;
        if (days.has(key)) return days.get(key);
        return ensureDay({
            normalizedKey: key,
            date: parts.date,
            time: parts.time,
            parsed: parseStoryDate(parts.date),
        });
    };

    for (const frame of frames) {
        const day = ensureDay(frame);
        const meta = frame.meta;
        if (!day.messageIndices.includes(frame.messageIndex)) day.messageIndices.push(frame.messageIndex);
        if (frame.time && !day.firstTime) day.firstTime = frame.time;
        if (frame.time) day.lastTime = frame.time;
        if (frame.anomaly) day.anomalies.push(frame.anomaly);

        const events = Array.isArray(meta.events) ? meta.events : (meta.event ? [meta.event] : []);
        for (let j = 0; j < events.length; j++) {
            const event = events[j];
            const summary = cleanText(event?.summary);
            if (!summary || isCalendarSummaryEvent(event, calendarSummaryTexts)) continue;
            const priorityRank = calendarEventPriority(event);
            addCalendarEvent(day, {
                id: stableMemoryId('E', frame.messageIndex, j, summary),
                messageIndex: frame.messageIndex,
                eventIndex: j,
                date: frame.date,
                time: frame.time,
                level: cleanText(event.level) || '一般',
                summary,
                priorityRank,
                priority: priorityRank >= 3 ? 'critical' : (priorityRank === 2 ? 'important' : 'normal'),
            });
        }

        const location = cleanText(meta.scene?.location);
        if (location && location !== previousLocation) {
            day.locationChanges.push({
                id: stableMemoryId('LC', frame.messageIndex, 0, `${previousLocation}|${location}`),
                from: previousLocation,
                to: location,
                time: frame.time,
                messageIndex: frame.messageIndex,
            });
            previousLocation = location;
        }

        // chat[0] stores the rebuilt global relationship snapshot. Historical
        // changes live on later messages and are the only ones shown here.
        if (frame.messageIndex > 0) {
            for (let j = 0; j < (meta.relationships || []).length; j++) {
                const relationship = meta.relationships[j] || {};
                const from = cleanText(relationship.from);
                const to = cleanText(relationship.to);
                const type = cleanText(relationship.type);
                const note = cleanText(relationship.note);
                if (!from || !to || !type || relationship._userEdited) continue;
                const key = `${from}\u0000${to}`;
                const previous = relationshipState.get(key);
                if (previous && previous.type === type && previous.note === note) continue;
                relationshipState.set(key, { type, note });
                day.relationshipChanges.push({
                    id: stableMemoryId('RC', frame.messageIndex, j, `${from}|${to}|${type}|${note}`),
                    action: previous ? 'update' : 'add',
                    from,
                    to,
                    type,
                    note,
                    time: frame.time,
                    messageIndex: frame.messageIndex,
                });
            }
        }

        const lifecycleAdds = (meta.agendaLifecycle || [])
            .filter(record => normalizeStatus(record?.action || record?.op, '') === 'add')
            .map(record => cleanText(record?.text || record?.title || record?.content));
        for (let j = 0; j < (meta.agenda || []).length; j++) {
            const normalized = normalizeLegacyAgenda(meta.agenda[j], frame.messageIndex, j, meta.timestamp || {});
            const key = normalizeProtocolId(normalized.id) || normalized.text;
            if (!normalized.text || seenLegacyAgenda.has(key) || lifecycleAdds.some(text => agendaTextMatches(text, normalized.text))) continue;
            seenLegacyAgenda.add(key);
            day.agendaChanges.push(describeAgendaChange({ ...normalized, action: 'add' }, frame.messageIndex, j, 'add'));
        }
        for (let j = 0; j < (meta.agendaLifecycle || []).length; j++) {
            day.agendaChanges.push(describeAgendaChange(meta.agendaLifecycle[j], frame.messageIndex, j));
        }
        for (let j = 0; j < (meta.deletedAgenda || []).length; j++) {
            day.agendaChanges.push(describeAgendaChange({ text: meta.deletedAgenda[j], action: 'close', status: 'completed' }, frame.messageIndex, j, 'close'));
        }

        let itemOrdinal = 0;
        for (const [name, info] of Object.entries(meta.items || {})) {
            const key = normalizeProtocolId(info?.id || info?._id) || itemBaseKey(name);
            const action = seenLegacyItems.has(key) ? 'snapshot' : 'add';
            seenLegacyItems.add(key);
            day.itemChanges.push(describeItemChange({ ...info, name, action }, frame.messageIndex, itemOrdinal++, action));
        }
        for (let j = 0; j < (meta.itemLifecycle || []).length; j++) {
            day.itemChanges.push(describeItemChange(meta.itemLifecycle[j], frame.messageIndex, j));
        }
        for (let j = 0; j < (meta.deletedItems || []).length; j++) {
            day.itemChanges.push(describeItemChange({ name: meta.deletedItems[j], action: 'close', status: 'consumed' }, frame.messageIndex, j, 'close'));
        }
    }

    // Older Horae builds could remove source events after compression. Project
    // the preserved originals back into the calendar without mutating chat data.
    const summaries = chat?.[0]?.horae_meta?.autoSummaries;
    if (Array.isArray(summaries)) {
        for (const summaryEntry of summaries) {
            if (!summaryEntry || summaryEntry.active === false || !Array.isArray(summaryEntry.originalEvents)) continue;
            for (let originalIndex = 0; originalIndex < summaryEntry.originalEvents.length; originalIndex++) {
                const original = summaryEntry.originalEvents[originalIndex];
                const messageIndex = Number(original?.msgIdx ?? original?.messageIndex);
                if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= limit) continue;

                const sourceMeta = chat?.[messageIndex]?.horae_meta;
                if (!sourceMeta || sourceMeta._skipHorae || isFlashbackMeta(sourceMeta)) continue;
                const event = original?.event;
                const eventSummary = cleanText(event?.summary);
                if (!eventSummary || isCalendarSummaryEvent(event, calendarSummaryTexts)) continue;

                const sourceFrame = frameByMessageIndex.get(messageIndex);
                const timestamp = original?.timestamp && typeof original.timestamp === 'object'
                    ? original.timestamp
                    : (sourceMeta.timestamp || {});
                const date = cleanText(sourceFrame?.date || timestamp.story_date || sourceMeta.timestamp?.story_date);
                if (!date) continue;
                const time = cleanText(sourceFrame?.time || timestamp.story_time || sourceMeta.timestamp?.story_time);
                const restoredFrame = sourceFrame || {
                    normalizedKey: normalizeStoryDateKey(date),
                    date,
                    time,
                    parsed: parseStoryDate(date),
                };
                if (!restoredFrame.normalizedKey) continue;

                const day = ensureDay(restoredFrame);
                if (!day.messageIndices.includes(messageIndex)) day.messageIndices.push(messageIndex);
                if (time && !day.firstTime) day.firstTime = time;
                if (time) day.lastTime = time;
                const eventIndex = Number.isInteger(original?.evtIdx) ? original.evtIdx : originalIndex;
                const priorityRank = calendarEventPriority(event);
                addCalendarEvent(day, {
                    id: stableMemoryId('E', messageIndex, eventIndex, eventSummary),
                    messageIndex,
                    eventIndex,
                    date,
                    time,
                    level: cleanText(event.level) || '一般',
                    summary: eventSummary,
                    priorityRank,
                    priority: priorityRank >= 3 ? 'critical' : (priorityRank === 2 ? 'important' : 'normal'),
                });
            }
        }
    }

    const agendaState = options.agenda || replayAgendaLifecycle(chat, limit, { clock });
    for (const agenda of agendaState.all) {
        const dueKey = lifecycleDateKey(agenda.dueAt);
        const dueDay = dueKey ? ensureDateDay(agenda.dueAt) : null;
        if (dueDay) {
            dueDay.agendaDue.push({
                id: agenda.id,
                text: agenda.text,
                dueAt: agenda.dueAt,
                status: agenda.status,
                priority: agenda.priority,
            });
        }
    }

    const itemState = options.items || replayItemLifecycle(chat, limit, { clock });
    for (const item of itemState.all) {
        const expiryKey = lifecycleDateKey(item.expiresAt);
        const targetDay = expiryKey ? ensureDateDay(item.expiresAt) : null;
        if (targetDay) {
            const alreadyRecorded = targetDay.itemChanges.some(change =>
                change.name === item.name && change.expiresAt === item.expiresAt
            );
            if (!alreadyRecorded) {
                targetDay.itemChanges.push(describeItemChange({
                    id: item.id,
                    name: item.name,
                    action: 'expiry',
                    status: item.status,
                    expiresAt: item.expiresAt,
                }, item._msgIndex ?? 0, 0, 'expiry'));
            }
        }
    }

    for (const day of days.values()) finalizeCalendarEvents(day);

    const parsedCurrent = parseStoryDate(clock.rawDate);
    const currentType = parsedCurrent?.type || 'unknown';
    const customCalendar = getActiveCustomCalendar();
    return {
        clock,
        currentKey: clock.normalizedKey,
        mode: currentType === 'standard' || (currentType === 'custom' && customCalendar) ? 'grid' : 'list',
        calendarType: currentType,
        calendarPrefix: cleanText(parsedCurrent?.calendarPrefix),
        customCalendar: customCalendar ? {
            monthNames: [...customCalendar.monthNames],
            monthDays: [...customCalendar.monthDays],
            yearLength: customCalendar.yearLength,
        } : null,
        days: [...days.values()],
        agenda: agendaState,
        items: itemState,
    };
}

/** Project enhanced active item state back to the legacy name-keyed shape. */
export function projectActiveItems(itemState) {
    const projected = {};
    for (const item of itemState?.active || []) {
        const quantity = item.quantity?.value;
        const unit = item.quantity?.unit || '';
        const displayName = quantity === null || quantity === undefined
            ? item.name
            : `${item.name}(${quantity}${unit})`;
        const stableId = item._id || item.id;
        const projectionKey = Object.hasOwn(projected, displayName)
            ? `${displayName} [#${stableId}]`
            : displayName;
        projected[projectionKey] = {
            ...item,
            _id: stableId,
            quantity: item.quantity,
        };
    }
    return projected;
}
