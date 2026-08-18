import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildSameDayLedger,
    buildStoryCalendar,
    buildStoryClock,
    parseMemoryProtocolLine,
    replayAgendaLifecycle,
    replayItemLifecycle,
    stableMemoryId,
} from '../core/memoryEngine.js';
import {
    cleanupLegacyAiScanMeta,
    getAddedAiScanRecordIndices,
    markAiScannedMeta,
    mergeAiScanRecords,
    restoreAiScannedMeta,
} from '../core/aiScanState.js';
import {
    composeHoraeInjectionPrompt,
    createEmptyMeta,
    filterUnequippedItemEntries,
    horaeManager,
} from '../core/horaeManager.js';
import { VectorManager } from '../core/vectorManager.js';

function message({ date = '', time = '', event = '', items = {}, agenda = [], itemLifecycle = [], agendaLifecycle = [], timeline = 'main' } = {}) {
    return {
        horae_meta: {
            timestamp: { story_date: date, story_time: time },
            storyClock: { rawDate: date, rawTime: time, timeline, confidence: 'high' },
            events: event ? [{ level: '一般', summary: event }] : [],
            items,
            agenda,
            itemLifecycle,
            agendaLifecycle,
        },
    };
}

test('上午事件在下午仍全部进入同日权威账本', () => {
    const chat = [
        message({ date: '2026/2/4', time: '09:00', event: '林夏在早餐时收到港口仓库的铜钥匙，并答应妥善保管。' }),
        message({ date: '2026/2/4', time: '11:30', event: '林夏从账房得知仓库昨夜曾有人闯入。' }),
        message({ date: '2026/2/4', time: '16:00', event: '林夏抵达港口，准备在傍晚前检查仓库。' }),
    ];
    const ledger = buildSameDayLedger(chat, chat.length, '2026-02-04');
    assert.equal(ledger.length, 3);
    assert.match(ledger[0].summary, /铜钥匙/);
    assert.equal(ledger[0].time, '09:00');
    assert.match(ledger[2].summary, /抵达港口/);
});

test('向量召回排除同日权威账本已承载的当前聊天楼层', async () => {
    const chat = [
        message({ date: '2026/2/3', time: '20:00', event: '林夏前一晚查到仓库属于旧商会。' }),
        message({ date: '2026/2/4', time: '09:00', event: '林夏上午取得仓库钥匙。' }),
        { is_user: true, mes: '继续调查。' },
        { is_user: true, mes: '检查门窗。' },
        { is_user: true, mes: '询问附近的人。' },
        { is_user: true, mes: '核对线索。' },
        { is_user: true, mes: '前往仓库。' },
        message({ date: '2026/2/4', time: '16:00', event: '林夏下午抵达仓库。' }),
    ];
    const manager = new VectorManager();
    manager.chatId = 'same-day-test';
    let receivedExclusions = null;
    manager._structuredQuery = (_query, _chat, _state, excludeIndices) => {
        receivedExclusions = new Set(excludeIndices);
        return [0, 1, 7]
            .filter(messageIndex => !excludeIndices.has(messageIndex))
            .map(messageIndex => ({
                messageIndex,
                similarity: 0.95,
                document: chat[messageIndex].horae_meta.events[0].summary,
                source: 'structured',
            }));
    };
    manager._hybridSearch = async () => [];

    const recall = await manager.generateRecallPrompt({
        getChat: () => chat,
        getLatestState: () => ({ timestamp: { story_date: '2026/2/4' }, scene: { characters_present: [] } }),
        getMemoryState: () => ({ sameDay: buildSameDayLedger(chat, chat.length, '2026/2/4') }),
    }, 0, {
        vectorTopK: 5,
        vectorThreshold: 0.7,
        vectorFullTextCount: 0,
    });

    assert.equal(receivedExclusions.has(1), true);
    assert.equal(receivedExclusions.has(7), true);
    assert.match(recall, /前一晚/);
    assert.doesNotMatch(recall, /上午取得|下午抵达/);
});

test('关闭当日权威账本后，同日较早楼层仍可参与向量召回', async () => {
    const chat = [
        message({ date: '2026/2/3', time: '20:00', event: '林夏前一晚查到仓库属于旧商会。' }),
        message({ date: '2026/2/4', time: '09:00', event: '林夏上午取得仓库钥匙。' }),
        { is_user: true, mes: '继续调查。' },
        { is_user: true, mes: '检查门窗。' },
        { is_user: true, mes: '询问附近的人。' },
        { is_user: true, mes: '核对线索。' },
        { is_user: true, mes: '前往仓库。' },
        message({ date: '2026/2/4', time: '16:00', event: '林夏下午抵达仓库。' }),
    ];
    const manager = new VectorManager();
    manager.chatId = 'same-day-disabled-test';
    let receivedExclusions = null;
    manager._structuredQuery = (_query, _chat, _state, excludeIndices) => {
        receivedExclusions = new Set(excludeIndices);
        return [1]
            .filter(messageIndex => !excludeIndices.has(messageIndex))
            .map(messageIndex => ({
                messageIndex,
                similarity: 0.95,
                document: chat[messageIndex].horae_meta.events[0].summary,
                source: 'structured',
            }));
    };
    manager._hybridSearch = async () => [];

    const recall = await manager.generateRecallPrompt({
        getChat: () => chat,
        getLatestState: () => ({ timestamp: { story_date: '2026/2/4' }, scene: { characters_present: [] } }),
        getMemoryState: () => ({ sameDay: buildSameDayLedger(chat, chat.length, '2026/2/4') }),
    }, 0, {
        sendSameDayMemory: false,
        vectorTopK: 5,
        vectorThreshold: 0.7,
        vectorFullTextCount: 0,
    });

    assert.equal(receivedExclusions.has(1), false);
    assert.match(recall, /上午取得仓库钥匙/);
});

test('上午获得的物品和建立的计划在下午仍活跃', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            itemLifecycle: [{ action: 'add', name: '仓库钥匙', qty: 1, unit: '把', holder: '林夏' }],
            agendaLifecycle: [{ action: 'add', text: '18:00与艾伦在钟楼见面', createdAt: '2026/2/4 09:00', dueAt: '2026/2/4 18:00' }],
        }),
        message({ date: '2026/2/4', time: '16:00', event: '林夏结束调查，准备前往钟楼。' }),
    ];
    const clock = buildStoryClock(chat);
    const items = replayItemLifecycle(chat, chat.length, { clock });
    const agenda = replayAgendaLifecycle(chat, chat.length, { clock });
    assert.equal(items.active.length, 1);
    assert.equal(items.active[0].name, '仓库钥匙');
    assert.equal(agenda.active.length, 1);
    assert.equal(agenda.active[0].status, 'pending');
});

test('超过截止时间只变为 overdue，不会自动完成', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            agendaLifecycle: [{ action: 'add', text: '18:00与艾伦见面', dueAt: '2026/2/4 18:00' }],
        }),
        message({ date: '2026/2/4', time: '19:00' }),
    ];
    const agenda = replayAgendaLifecycle(chat);
    assert.equal(agenda.active.length, 1);
    assert.equal(agenda.active[0].status, 'overdue');
    assert.equal(agenda.archived.length, 0);
});

test('几天后的计划跨到第二天仍保持 pending', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            agendaLifecycle: [{
                action: 'add',
                text: '三天后前往王都',
                createdAt: '2026/2/4 09:00',
                dueAt: '2026/2/7 08:00',
            }],
        }),
        message({ date: '2026/2/5', time: '12:00' }),
    ];

    const agenda = replayAgendaLifecycle(chat);
    assert.equal(agenda.active.length, 1);
    assert.equal(agenda.active[0].status, 'pending');
    assert.equal(agenda.active[0].dueAt, '2026/2/7 08:00');
    assert.equal(agenda.archived.length, 0);
});

test('最终发送给 AI 的内容包含当日权威记忆和跨日保留的未来计划', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            event: '林夏上午取得仓库钥匙。',
            agendaLifecycle: [{
                id: 'A-CAPITAL',
                action: 'add',
                text: '三天后前往王都',
                createdAt: '2026/2/4 09:00',
                dueAt: '2026/2/7 08:00',
            }],
        }),
        message({ date: '2026/2/5', time: '09:00', event: '第二天林夏在旅店整理行装。' }),
        message({ date: '2026/2/5', time: '16:00', event: '下午林夏确认了前往王都的路线。' }),
    ];
    const oldContext = horaeManager.context;
    const oldSettings = horaeManager.settings;

    try {
        horaeManager.init({ chat, name1: '林夏', name2: '艾伦' }, {
            aiOutputLanguage: 'zh-CN',
            sendTimeline: true,
            sendSameDayMemory: true,
            sendAgenda: true,
            sendItems: false,
            sendCharacters: false,
            contextDepth: 15,
            customSystemPrompt: '[规则测试]',
        });

        const dataPrompt = horaeManager.generateCompactPrompt();
        const rulesPrompt = horaeManager.generateSystemPromptAddition();
        const finalPrompt = composeHoraeInjectionPrompt(dataPrompt, '[向量召回测试]', rulesPrompt);

        assert.match(finalPrompt, /\[当日记忆（权威）\]/);
        assert.match(finalPrompt, /第二天林夏在旅店整理行装/);
        assert.match(finalPrompt, /下午林夏确认了前往王都的路线/);
        assert.match(finalPrompt, /\[待办事项\]/);
        assert.match(finalPrompt, /#A-CAPITAL 三天后前往王都 \[pending\] \| 截止:2026\/2\/7 08:00/);
        assert.match(finalPrompt, /跨到第二天也不得清除几天后的计划/);
        assert.match(finalPrompt, /跨到第二天也不得提前完成、失效或删除几天后的计划/);
        assert.match(finalPrompt, /\[向量召回测试\]\n\[规则测试\]/);
        assert.ok(finalPrompt.indexOf('[待办事项]') < finalPrompt.indexOf('[向量召回测试]'));
        assert.ok(finalPrompt.indexOf('[向量召回测试]') < finalPrompt.indexOf('[规则测试]'));
    } finally {
        horaeManager.context = oldContext;
        horaeManager.settings = oldSettings;
    }
});

test('记忆发送开关关闭后不重复注入区块，事件仍由剧情轨迹兜底', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            event: '林夏上午取得仓库钥匙。',
            agendaLifecycle: [{ action: 'add', text: '三天后前往王都', dueAt: '2026/2/7 08:00' }],
        }),
        message({ date: '2026/2/4', time: '16:00', event: '林夏下午抵达仓库。' }),
    ];
    const oldContext = horaeManager.context;
    const oldSettings = horaeManager.settings;

    try {
        horaeManager.init({ chat, name1: '林夏', name2: '艾伦' }, {
            aiOutputLanguage: 'zh-CN',
            sendTimeline: true,
            sendSameDayMemory: false,
            sendAgenda: false,
            sendItems: false,
            sendCharacters: false,
            contextDepth: 15,
        });

        const prompt = horaeManager.generateCompactPrompt();
        assert.doesNotMatch(prompt, /\[当日记忆（权威）\]/);
        assert.doesNotMatch(prompt, /\[待办事项\]/);
        assert.match(prompt, /\[剧情轨迹\]/);
        assert.match(prompt, /上午取得仓库钥匙/);
        assert.match(prompt, /下午抵达仓库/);
    } finally {
        horaeManager.context = oldContext;
        horaeManager.settings = oldSettings;
    }
});

test('面板覆盖可设置和清除计划截止时间而不改写建立时间', () => {
    const base = message({
        date: '2026/2/4',
        time: '09:00',
        agendaLifecycle: [{ id: 'A-MEET', action: 'add', text: '与艾伦见面', createdAt: '2026/2/4 09:00' }],
    });
    base.horae_meta._agendaOverrides = [{ action: 'update', targetId: 'A-MEET', dueAt: '2026/2/4 18:00' }];

    const scheduled = replayAgendaLifecycle([base]);
    assert.equal(scheduled.active[0].createdAt, '2026/2/4 09:00');
    assert.equal(scheduled.active[0].dueAt, '2026/2/4 18:00');

    base.horae_meta._agendaOverrides.push({ action: 'update', targetId: 'A-MEET', dueAt: null });
    const cleared = replayAgendaLifecycle([base]);
    assert.equal(cleared.active[0].createdAt, '2026/2/4 09:00');
    assert.equal(cleared.active[0].dueAt, null);
});

test('五个苹果吃掉两个后剩三个', () => {
    const chat = [
        message({ date: '2026/2/4', time: '09:00', itemLifecycle: [{ action: 'add', name: '苹果', qty: 5, unit: '个' }] }),
        message({ date: '2026/2/4', time: '12:00', itemLifecycle: [{ action: 'update', name: '苹果', delta: -2, reason: '午餐吃掉两个' }] }),
    ];
    const items = replayItemLifecycle(chat);
    assert.equal(items.active[0].quantity.value, 3);
    assert.equal(items.active[0].quantity.unit, '个');
});

test('旧格式陈旧快照不会复活已消耗物品', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            items: { '苹果(1个)': { id: 'I-APPLE', holder: '林夏' } },
        }),
        message({
            date: '2026/2/4',
            time: '12:00',
            itemLifecycle: [{ action: 'close', targetId: 'I-APPLE', status: 'consumed', reason: '午餐吃掉' }],
        }),
        message({
            date: '2026/2/4',
            time: '16:00',
            items: { '苹果(1个)': { id: 'I-APPLE', holder: '林夏' } },
        }),
    ];

    const items = replayItemLifecycle(chat);
    assert.equal(items.active.length, 0);
    assert.equal(items.archived[0].status, 'consumed');
    assert.equal(items.archived[0].quantity.value, 0);
    assert.equal(items.archived[0].history.at(-1).action, 'ignored-legacy-snapshot');
});

test('明确 item+ 可以重新获得已关闭物品', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            itemLifecycle: [{ id: 'I-KEY', action: 'add', name: '仓库钥匙', qty: 1 }],
        }),
        message({
            date: '2026/2/4',
            time: '12:00',
            itemLifecycle: [{ action: 'close', targetId: 'I-KEY', status: 'lost' }],
        }),
        message({
            date: '2026/2/4',
            time: '16:00',
            itemLifecycle: [{ id: 'I-KEY', action: 'add', name: '仓库钥匙', qty: 1, holder: '林夏' }],
        }),
    ];

    const items = replayItemLifecycle(chat);
    assert.equal(items.active.length, 1);
    assert.equal(items.active[0].id, 'I-KEY');
    assert.equal(items.active[0].status, 'active');
    assert.equal(items.active[0].quantity.value, 1);
});

test('明确到期的物品和计划退出活跃清单，但保留历史', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            itemLifecycle: [{ action: 'add', name: '临时通行证', expiresAt: '2026/2/4 18:00' }],
            agendaLifecycle: [{ action: 'add', text: '领取限时补给', expiresAt: '2026/2/4 18:00' }],
        }),
        message({ date: '2026/2/4', time: '19:00' }),
    ];
    const clock = buildStoryClock(chat);
    const items = replayItemLifecycle(chat, chat.length, { clock });
    const agenda = replayAgendaLifecycle(chat, chat.length, { clock });
    assert.equal(items.active.length, 0);
    assert.equal(items.archived[0].status, 'expired');
    assert.equal(agenda.active.length, 0);
    assert.equal(agenda.archived[0].status, 'expired');
});

test('只有日期的到期时间在当天有效并于次日过期', () => {
    const acquired = message({
        date: '2026/2/4',
        time: '09:00',
        itemLifecycle: [{ action: 'add', name: '当日通行证', expiresAt: '2026/2/4' }],
        agendaLifecycle: [{ action: 'add', text: '当日领取补给', expiresAt: '2026/2/4' }],
    });
    const sameDay = [acquired, message({ date: '2026/2/4', time: '23:59' })];
    const nextDay = [...sameDay, message({ date: '2026/2/5', time: '00:01' })];

    assert.equal(replayItemLifecycle(sameDay).active.length, 1);
    assert.equal(replayAgendaLifecycle(sameDay).active.length, 1);
    assert.equal(replayItemLifecycle(nextDay).archived[0].status, 'expired');
    assert.equal(replayAgendaLifecycle(nextDay).archived[0].status, 'expired');
});

test('agenda 兼容投影不会吞掉生命周期的失效时间', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            agenda: [{ text: '领取限时补给', dueAt: '2026/2/4 17:00' }],
            agendaLifecycle: [{ action: 'add', text: '领取限时补给', dueAt: '2026/2/4 17:00', expiresAt: '2026/2/4 18:00' }],
        }),
        message({ date: '2026/2/4', time: '19:00' }),
    ];
    const agenda = replayAgendaLifecycle(chat);
    assert.equal(agenda.active.length, 0);
    assert.equal(agenda.archived[0].expiresAt, '2026/2/4 18:00');
    assert.equal(agenda.archived[0].status, 'expired');
});

test('每日递减规则按剧情日期减少数量', () => {
    const chat = [
        message({ date: '2026/2/4', time: '09:00', itemLifecycle: [{ action: 'add', name: '旅行口粮', qty: 5, unit: '份', decayPolicy: 'per_day:1' }] }),
        message({ date: '2026/2/6', time: '09:00' }),
    ];
    const items = replayItemLifecycle(chat);
    assert.equal(items.active[0].quantity.value, 3);
});

test('旧格式重复数量快照视为当日权威确认且不会重复扣减', () => {
    const chat = [
        message({ date: '2026/2/4', time: '09:00', items: { '旅行口粮(5份)': { id: 'I-RATION', decayPolicy: 'per_day:1' } } }),
        message({ date: '2026/2/5', time: '09:00', items: { '旅行口粮(4份)': { id: 'I-RATION', decayPolicy: 'per_day:1' } } }),
        message({ date: '2026/2/6', time: '09:00', items: { '旅行口粮(3份)': { id: 'I-RATION', decayPolicy: 'per_day:1' } } }),
        message({ date: '2026/2/7', time: '09:00' }),
    ];
    const items = replayItemLifecycle(chat);
    assert.equal(items.active[0].quantity.value, 2);
    assert.equal(items.active[0].lastConfirmedAt, '2026/2/6 09:00');
    assert.equal(items.active[0].history.filter(entry => entry.action === 'decay').length, 3);
});

test('相同旧数量快照会重申该时点数量，再从最新确认时间继续衰减', () => {
    const chat = [
        message({ date: '2026/2/4', time: '09:00', items: { '旅行口粮(5份)': { id: 'I-RATION', decayPolicy: 'per_day:1' } } }),
        message({ date: '2026/2/5', time: '09:00', items: { '旅行口粮(5份)': { id: 'I-RATION', decayPolicy: 'per_day:1' } } }),
        message({ date: '2026/2/7', time: '09:00' }),
    ];
    const items = replayItemLifecycle(chat);
    assert.equal(items.active[0].quantity.value, 3);
});

test('无说明的时间倒退记录异常并保持主线时钟', () => {
    const chat = [
        message({ date: '2026/2/4', time: '16:00' }),
        message({ date: '2026/2/4', time: '09:00' }),
    ];
    const clock = buildStoryClock(chat);
    assert.equal(clock.rawTime, '16:00');
    assert.equal(clock.anomaly.type, 'backward_time_jump');
    assert.equal(clock.anomaly.messageIndex, 1);
});

test('错误倒退时间不会让新事件掉出当前主线的当日账本', () => {
    const chat = [
        message({ date: '2026/2/4', time: '16:00', event: '林夏下午抵达港口仓库。' }),
        message({ date: '2026/2/4', time: '09:00', event: '林夏随后打开仓库暗门。' }),
    ];
    const clock = buildStoryClock(chat);
    const ledger = buildSameDayLedger(chat, chat.length, clock.rawDate);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[1].time, '16:00');
    assert.match(ledger[1].summary, /打开仓库暗门/);
});

test('闪回不推进时钟、不进入同日账本、不改变物品计划', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '16:00',
            event: '林夏正在港口仓库调查。',
            itemLifecycle: [{ action: 'add', name: '仓库钥匙' }],
            agendaLifecycle: [{ action: 'add', text: '返回旅店汇报' }],
        }),
        message({
            date: '2020/1/1',
            time: '08:00',
            timeline: 'flashback',
            event: '六年前林夏在故乡遗失木牌。',
            itemLifecycle: [{ action: 'close', name: '仓库钥匙', status: 'lost' }],
            agendaLifecycle: [{ action: 'close', text: '返回旅店汇报', status: 'completed' }],
        }),
    ];
    const clock = buildStoryClock(chat);
    assert.equal(clock.rawDate, '2026/2/4');
    assert.equal(clock.rawTime, '16:00');
    assert.equal(buildSameDayLedger(chat, chat.length, clock.rawDate).length, 1);
    assert.equal(replayItemLifecycle(chat, chat.length, { clock }).active.length, 1);
    assert.equal(replayAgendaLifecycle(chat, chat.length, { clock }).active.length, 1);
});

test('跨日缺少时刻时不会继承前一天的精确时刻', () => {
    const chat = [
        message({ date: '2026/2/4', time: '16:00' }),
        message({ date: '2026/2/5', time: '' }),
    ];
    const clock = buildStoryClock(chat);
    assert.equal(clock.rawDate, '2026/2/5');
    assert.equal(clock.rawTime, '');
    assert.equal(clock.confidence, 'low');
});

test('跨日账本不会把前一天的时刻标到新一天事件上', () => {
    const chat = [
        message({ date: '2026/2/4', time: '16:00', event: '林夏离开港口。' }),
        message({ date: '2026/2/5', time: '', event: '次日林夏收到一封没有署名的信。' }),
    ];
    const ledger = buildSameDayLedger(chat, chat.length, '2026/2/5');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].time, '');
    assert.match(ledger[0].summary, /没有署名的信/);
});

test('删除或编辑来源楼层后，重放结果随有效历史变化', () => {
    const acquired = message({ date: '2026/2/4', time: '09:00', itemLifecycle: [{ action: 'add', name: '银钥匙' }] });
    const spent = message({ date: '2026/2/4', time: '10:00', itemLifecycle: [{ action: 'close', name: '银钥匙', status: 'lost' }] });
    const chat = [acquired, spent];
    assert.equal(replayItemLifecycle(chat).active.length, 0);
    assert.equal(replayItemLifecycle([acquired]).active.length, 1);
    acquired.horae_meta.itemLifecycle[0].name = '铜钥匙';
    assert.equal(replayItemLifecycle([acquired]).active[0].name, '铜钥匙');
});

test('旧 item 和 agenda 数据无需迁移即可直接重放', () => {
    const chat = [message({
        date: '2026/2/4',
        time: '09:00',
        items: { '苹果(5个)': { holder: '林夏', location: '背包' } },
        agenda: [{ text: '傍晚去钟楼', date: '2026/2/4', done: false }],
    })];
    const items = replayItemLifecycle(chat);
    const agenda = replayAgendaLifecycle(chat);
    assert.equal(items.active[0].name, '苹果');
    assert.equal(items.active[0].quantity.value, 5);
    assert.equal(agenda.active[0].text, '傍晚去钟楼');
});

test('稳定 ID 在多次重放中保持一致', () => {
    const id = stableMemoryId('I', 12, 0, '仓库钥匙');
    assert.equal(stableMemoryId('I', 12, 0, '仓库钥匙'), id);
    assert.notEqual(stableMemoryId('I', 13, 0, '仓库钥匙'), id);
});

test('新生命周期协议可解析直观写法和完整字段', () => {
    const add = parseMemoryProtocolLine('item+:name=苹果|qty=5|unit=个|acquiredAt=2026/2/4 09:00|lastConfirmedAt=2026/2/4 10:00|decayPolicy=per_day:1');
    const consume = parseMemoryProtocolLine('itemx:苹果');
    const agenda = parseMemoryProtocolLine('agenda!:赴约');
    assert.equal(add.kind, 'item');
    assert.equal(add.record.qty, 5);
    assert.equal(add.record.acquiredAt, '2026/2/4 09:00');
    assert.equal(add.record.lastConfirmedAt, '2026/2/4 10:00');
    assert.equal(add.record.decayPolicy, 'per_day:1');
    assert.equal(consume.record.name, '苹果');
    assert.equal(consume.record.action, 'close');
    assert.equal(agenda.record.text, '赴约');
    assert.equal(agenda.record.status, 'completed');
});

test('生命周期协议保留布尔锁定和结构化字段类型', () => {
    const item = parseMemoryProtocolLine('item~:targetId=I100|_locked=false|qty={"value":2,"unit":"瓶"}|decayPolicy={"type":"per_day","amount":1,"note":"晨|晚"}');
    const agenda = parseMemoryProtocolLine('agenda+:text=轮值|participants=["林夏","艾伦"]|recurrence={"type":"daily","interval":1}');

    assert.equal(item.record._locked, false);
    assert.deepEqual(item.record.qty, { value: 2, unit: '瓶' });
    assert.deepEqual(item.record.decayPolicy, { type: 'per_day', amount: 1, note: '晨|晚' });
    assert.deepEqual(agenda.record.participants, ['林夏', '艾伦']);
    assert.deepEqual(agenda.record.recurrence, { type: 'daily', interval: 1 });
});

test('计划参与者在新增合并与后续更新中完整保留', () => {
    const chat = [message({
        date: '2026/2/4',
        time: '09:00',
        agenda: [{ id: 'A-WATCH', text: '港口轮值', participants: ['林夏'] }],
        agendaLifecycle: [
            { id: 'A-WATCH', action: 'add', text: '港口轮值', participants: ['林夏', '艾伦'] },
            { targetId: 'A-WATCH', action: 'update', participants: ['林夏', '艾伦', '米娅'] },
        ],
    })];

    const agenda = replayAgendaLifecycle(chat);
    assert.deepEqual(agenda.active[0].participants, ['林夏', '艾伦', '米娅']);
});

test('显式不同稳定 ID 的同名计划不会被重放器合并', () => {
    const chat = [message({
        date: '2026/2/4',
        time: '09:00',
        agenda: [
            { id: 'A-MORNING', text: '去钟楼', dueAt: '2026/2/4 10:00' },
            { id: 'A-EVENING', text: '去钟楼', dueAt: '2026/2/4 18:00' },
        ],
    })];

    const agenda = replayAgendaLifecycle(chat);
    assert.equal(agenda.active.length, 2);
    assert.deepEqual(agenda.active.map(item => item.id), ['A-MORNING', 'A-EVENING']);
});

test('明确 agenda+ 可以重新开启已完成计划', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            agendaLifecycle: [{ id: 'A-WATCH', action: 'add', text: '港口轮值' }],
        }),
        message({
            date: '2026/2/4',
            time: '12:00',
            agendaLifecycle: [{ action: 'close', targetId: 'A-WATCH', status: 'completed' }],
        }),
        message({
            date: '2026/2/5',
            time: '09:00',
            agendaLifecycle: [{ id: 'A-WATCH', action: 'add', text: '港口轮值', dueAt: '2026/2/5 18:00' }],
        }),
    ];

    const agenda = replayAgendaLifecycle(chat);
    assert.equal(agenda.active.length, 1);
    assert.equal(agenda.active[0].id, 'A-WATCH');
    assert.equal(agenda.active[0].status, 'pending');
    assert.equal(agenda.active[0].dueAt, '2026/2/5 18:00');
});

test('同一楼层重复解析不会重复应用生命周期变化', () => {
    const parsed = horaeManager.parseHoraeTag(`<horae>
time:2026/2/4 12:00
time_context:main|confidence=high
item~:name=苹果|delta=-2|lastChangedAt=2026/2/4 12:00
agenda~:text=赴约|status=in_progress|lastChangedAt=2026/2/4 12:00
</horae>`);
    const once = horaeManager.mergeParsedToMeta(createEmptyMeta(), parsed);
    const twice = horaeManager.mergeParsedToMeta(once, parsed);
    assert.equal(twice.itemLifecycle.length, 1);
    assert.equal(twice.itemLifecycle[0].delta, -2);
    assert.equal(twice.itemLifecycle[0].lastChangedAt, '2026/2/4 12:00');
    assert.equal(twice.agendaLifecycle.length, 1);
    assert.equal(twice.agendaLifecycle[0].status, 'in_progress');
});

test('用户覆盖层按 ID 完成或归档计划，不修改来源记录', () => {
    const base = message({ date: '2026/2/4', time: '09:00', agenda: [{ id: 'A100', text: '去钟楼', done: false }] });
    base.horae_meta._agendaOverrides = [{ action: 'update', targetId: 'A100', status: 'completed' }];
    const completed = replayAgendaLifecycle([base]);
    assert.equal(completed.active.length, 0);
    assert.equal(completed.archived[0].status, 'completed');
    assert.equal(base.horae_meta.agenda[0].done, false);

    base.horae_meta._agendaOverrides = [];
    base.horae_meta._deletedAgendaIds = ['A100'];
    const archived = replayAgendaLifecycle([base]);
    assert.equal(archived.archived[0].status, 'archived');
});

test('无时间的计划面板覆盖不会清空原变更时间', () => {
    const base = message({
        date: '2026/2/4',
        time: '09:00',
        agenda: [{ id: 'A100', text: '去钟楼', lastChangedAt: '2026/2/4 09:00' }],
    });
    base.horae_meta._agendaOverrides = [{ action: 'update', targetId: 'A100', status: 'in_progress' }];

    const state = replayAgendaLifecycle([base]);
    assert.equal(state.active[0].lastChangedAt, '2026/2/4 09:00');
});

test('用户归档生命周期物品后不会在重放中复活', () => {
    const base = message({
        date: '2026/2/4',
        time: '09:00',
        itemLifecycle: [{ id: 'I100', action: 'add', name: '仓库钥匙', qty: 1 }],
    });
    base.horae_meta._deletedItemIds = ['I100'];

    const archived = replayItemLifecycle([base]);
    assert.equal(archived.active.length, 0);
    assert.equal(archived.archived[0].status, 'archived');
    assert.equal(base.horae_meta.itemLifecycle[0].action, 'add');
});

test('移除物品归档标记后以同一稳定 ID 恢复', () => {
    const base = message({
        date: '2026/2/4',
        time: '09:00',
        itemLifecycle: [{ action: 'add', name: '无编号仓库钥匙', qty: 1 }],
    });
    const original = replayItemLifecycle([base]).active[0];
    base.horae_meta._deletedItemIds = [original.id];

    const archived = replayItemLifecycle([base]);
    assert.equal(archived.archived[0].id, original.id);
    assert.equal(archived.archived[0].lastChangedAt, '2026/2/4 09:00');

    base.horae_meta._deletedItemIds = [];
    const restored = replayItemLifecycle([base]);
    assert.equal(restored.active[0].id, original.id);
    assert.equal(restored.active[0].status, 'active');
});

test('物品覆盖层可编辑生命周期物品且不修改来源记录', () => {
    const base = message({
        date: '2026/2/4',
        time: '09:00',
        itemLifecycle: [{ id: 'I100', action: 'add', name: '仓库钥匙', holder: '林夏' }],
    });
    base.horae_meta._itemOverrides = [{
        action: 'update',
        targetId: 'I100',
        name: '铜制仓库钥匙',
        holder: '艾伦',
        icon: 'KEY',
        _locked: true,
    }];

    const state = replayItemLifecycle([base]);
    assert.equal(state.active[0].name, '铜制仓库钥匙');
    assert.equal(state.active[0].holder, '艾伦');
    assert.equal(state.active[0].icon, 'KEY');
    assert.equal(state.active[0]._locked, true);
    assert.equal(base.horae_meta.itemLifecycle[0].name, '仓库钥匙');
});

test('物品更新可显式解除锁定并保留独立确认时间', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            itemLifecycle: [{ id: 'I100', action: 'add', name: '仓库钥匙', _locked: true }],
        }),
        message({
            date: '2026/2/4',
            time: '12:00',
            itemLifecycle: [{ action: 'update', targetId: 'I100', _locked: false, lastConfirmedAt: '2026/2/4 11:30' }],
        }),
    ];
    const state = replayItemLifecycle(chat);
    assert.equal(state.active[0]._locked, false);
    assert.equal(state.active[0].lastChangedAt, '2026/2/4 12:00');
    assert.equal(state.active[0].lastConfirmedAt, '2026/2/4 11:30');
});

test('显式不同稳定 ID 的同名物品不会被重放器合并', () => {
    const chat = [message({
        date: '2026/2/4',
        time: '09:00',
        itemLifecycle: [
            { id: 'I-A', action: 'add', name: '通行证', holder: '林夏' },
            { id: 'I-B', action: 'add', name: '通行证', holder: '艾伦' },
        ],
    })];

    const state = replayItemLifecycle(chat);
    assert.equal(state.active.length, 2);
    assert.deepEqual(state.active.map(item => item.id), ['I-A', 'I-B']);
    assert.deepEqual(state.active.map(item => item.holder), ['林夏', '艾伦']);
});

test('装备过滤按稳定 ID 区分同名物品', () => {
    const items = [
        ['通行证 [#I-A]', { id: 'I-A', name: '通行证' }],
        ['通行证 [#I-B]', { id: 'I-B', name: '通行证' }],
    ];
    const equipment = {
        林夏: {
            饰品: [{ name: '通行证', _itemMeta: { id: 'I-A' } }],
        },
    };
    const remaining = filterUnequippedItemEntries(items, equipment);
    assert.deepEqual(remaining.map(([, info]) => info.id), ['I-B']);
});

test('无稳定 ID 的旧装备按名称只过滤对应数量', () => {
    const items = [
        ['通行证 [#I-A]', { id: 'I-A', name: '通行证' }],
        ['通行证 [#I-B]', { id: 'I-B', name: '通行证' }],
    ];
    const equipment = { 林夏: { 饰品: [{ name: '通行证' }] } };
    const remaining = filterUnequippedItemEntries(items, equipment);
    assert.deepEqual(remaining.map(([, info]) => info.id), ['I-B']);
});

test('自动穿脱装备使用覆盖层且不删除历史物品来源', () => {
    const base = message({
        date: '2026/2/4',
        time: '09:00',
        itemLifecycle: [{ id: 'I-PASS', action: 'add', name: '通行证', holder: '林夏' }],
    });
    const equipChanges = {
        equipment: [{ owner: '林夏', slot: '饰品', name: '通行证', attrs: { 交涉: 1 } }],
        unequip: [],
    };
    base.horae_meta._rpgChanges = equipChanges;
    const oldContext = horaeManager.context;
    const oldSettings = horaeManager.settings;

    try {
        horaeManager.init({ chat: [base], name1: '林夏', name2: '艾伦' }, {});
        horaeManager._mergeRpgData(equipChanges, false, 0);

        assert.equal(base.horae_meta.itemLifecycle[0].action, 'add');
        assert.equal(base.horae_meta.itemLifecycle[0].name, '通行证');
        assert.deepEqual(base.horae_meta._deletedItemIds, ['I-PASS']);
        assert.equal(equipChanges.equipment[0].itemId, 'I-PASS');
        assert.equal(base.horae_meta.rpg.equipment.林夏.饰品[0]._itemMeta.id, 'I-PASS');
        assert.equal(replayItemLifecycle([base]).active.length, 0);

        const unequipChanges = {
            equipment: [],
            unequip: [{ owner: '林夏', slot: '饰品', name: '通行证' }],
        };
        horaeManager._mergeRpgData(unequipChanges, false, 1);

        assert.equal(unequipChanges.unequip[0].itemId, 'I-PASS');
        assert.deepEqual(base.horae_meta._deletedItemIds, []);
        assert.equal(base.horae_meta._itemOverrides[0].targetId, 'I-PASS');
        assert.equal(replayItemLifecycle([base]).active[0].id, 'I-PASS');
        assert.equal(base.horae_meta.itemLifecycle[0].action, 'add');
    } finally {
        horaeManager.context = oldContext;
        horaeManager.settings = oldSettings;
    }
});

test('叙事日历按主线日期聚合事件、计划和物品变化', () => {
    const chat = [
        message({
            date: '2026/2/4',
            time: '09:00',
            event: '林夏收到仓库钥匙。',
            itemLifecycle: [{ action: 'add', name: '仓库钥匙', qty: 1 }],
            agendaLifecycle: [{ action: 'add', text: '傍晚检查仓库', dueAt: '2026/2/4 18:00' }],
        }),
        message({
            date: '2020/1/1',
            time: '08:00',
            timeline: 'flashback',
            event: '六年前林夏遗失旧钥匙。',
        }),
        message({
            date: '2026/2/4',
            time: '16:00',
            event: '林夏抵达仓库。',
            agendaLifecycle: [{ action: 'update', text: '傍晚检查仓库', status: 'in_progress' }],
        }),
    ];

    const calendar = buildStoryCalendar(chat);
    assert.equal(calendar.mode, 'grid');
    assert.equal(calendar.days.length, 1);
    assert.equal(calendar.days[0].events.length, 2);
    assert.equal(calendar.days[0].agendaChanges.length, 2);
    assert.equal(calendar.days[0].agendaDue.length, 1);
    assert.equal(calendar.days[0].itemChanges.length, 1);
    assert.equal(calendar.days[0].firstTime, '09:00');
    assert.equal(calendar.days[0].lastTime, '16:00');
    assert.equal(calendar.days[0].current, true);
    assert.doesNotMatch(calendar.days[0].events.map(event => event.summary).join(' '), /六年前/);
});

test('叙事日历合并带年份与不带年份的同一日期', () => {
    for (const dates of [['2026/2/4', '2/4'], ['2/4', '2026/2/4']]) {
        const chat = [
            message({ date: dates[0], time: '09:00', event: '上午确认仓库门锁完好。' }),
            message({ date: dates[1], time: '16:00', event: '下午返回仓库取证。' }),
        ];
        const calendar = buildStoryCalendar(chat);
        assert.equal(calendar.clock.rawDate, '2026/2/4');
        assert.equal(calendar.days.length, 1);
        assert.equal(calendar.days[0].year, 2026);
        assert.equal(calendar.days[0].events.length, 2);
        assert.equal(calendar.days[0].current, true);
    }
});

test('无法解析成数值月份的奇幻日期使用顺序列表', () => {
    const chat = [message({ date: '霜降月第七日', time: '午时', event: '众人抵达北境。' })];
    const calendar = buildStoryCalendar(chat);
    assert.equal(calendar.mode, 'list');
    assert.equal(calendar.days[0].date, '霜降月第七日');
    assert.equal(calendar.days[0].events.length, 1);
});

test('AI 扫描撤销可完整恢复扫描前元数据', () => {
    const original = message({
        date: '2026/2/4',
        time: '09:00',
        event: '原有的手工事件。',
        items: { 旧钥匙: { holder: '林夏' } },
        agenda: [{ text: '原有计划' }],
        itemLifecycle: [{ id: 'I-OLD', action: 'add', name: '旧钥匙' }],
        agendaLifecycle: [{ id: 'A-OLD', action: 'add', text: '原有计划' }],
    }).horae_meta;
    original.customUserField = { keep: true };

    const scanned = markAiScannedMeta({
        ...original,
        events: [{ summary: '扫描生成事件。' }],
        itemLifecycle: [{ id: 'I-NEW', action: 'add', name: '新物品' }],
        agendaLifecycle: [{ id: 'A-NEW', action: 'add', text: '新计划' }],
        storyClock: { rawDate: '2026/2/5', timeline: 'main' },
    }, original);

    assert.deepEqual(restoreAiScannedMeta(scanned), original);
});

test('AI 二次扫描沿用最初备份而不覆盖原始状态', () => {
    const original = message({ date: '2026/2/4', time: '09:00', event: '扫描前事件。' }).horae_meta;
    const first = markAiScannedMeta({ ...original, events: [{ summary: '第一次扫描。' }] }, original);
    const second = markAiScannedMeta({ ...first, events: [{ summary: '第二次扫描。' }] }, first);

    assert.deepEqual(second._aiScanBackup, original);
    assert.deepEqual(restoreAiScannedMeta(second), original);
});

test('AI 扫描数组保留旧记录、追加新记录且不制造重复', () => {
    const original = [{ id: 'I-OLD', action: 'add', name: '旧钥匙' }];
    const scanned = [
        { id: 'I-OLD', action: 'add', name: '旧钥匙' },
        { id: 'I-NEW', action: 'add', name: '新钥匙' },
        { id: 'I-NEW', action: 'add', name: '新钥匙' },
    ];

    const merged = mergeAiScanRecords(original, scanned);
    assert.deepEqual(merged, [original[0], scanned[1]]);
    assert.deepEqual(getAddedAiScanRecordIndices(merged, original), [1]);
});

test('AI 审阅新增索引按重复次数区分旧记录与新记录', () => {
    const oldEvent = { level: '重要', summary: '原有事件' };
    const newEvent = { level: '一般', summary: '扫描事件' };
    const current = [oldEvent, oldEvent, newEvent];

    assert.deepEqual(getAddedAiScanRecordIndices(current, [oldEvent]), [1, 2]);
});

test('旧版无备份扫描数据撤销时清理生命周期与故事时钟', () => {
    const legacy = {
        ...message({
            date: '2026/2/4',
            time: '16:00',
            event: '旧版扫描事件。',
            items: { 苹果: { holder: '林夏' } },
            agenda: [{ text: '旧版扫描计划' }],
            itemLifecycle: [{ action: 'add', name: '苹果' }],
            agendaLifecycle: [{ action: 'add', text: '旧版扫描计划' }],
        }).horae_meta,
        _aiScanned: true,
        customUserField: 'preserved',
        tableContributions: [{ name: '扫描表格' }],
    };

    const restored = restoreAiScannedMeta(legacy);
    assert.deepEqual(restored.itemLifecycle, []);
    assert.deepEqual(restored.agendaLifecycle, []);
    assert.deepEqual(restored.agenda, []);
    assert.deepEqual(restored.events, []);
    assert.equal(restored.storyClock, null);
    assert.equal(restored.timestamp.story_date, '');
    assert.equal(restored.customUserField, 'preserved');
    assert.equal('_aiScanned' in restored, false);
    assert.equal('tableContributions' in restored, false);
});

test('旧版清理结果可作为后续扫描的原始备份', () => {
    const legacy = {
        ...message({
            date: '2026/2/4',
            time: '16:00',
            itemLifecycle: [{ action: 'add', name: '扫描物品' }],
            agendaLifecycle: [{ action: 'add', text: '扫描计划' }],
        }).horae_meta,
        _aiScanned: true,
    };
    const expected = cleanupLegacyAiScanMeta(legacy);
    const rescanned = markAiScannedMeta({ ...legacy, events: [{ summary: '再次扫描。' }] }, legacy);

    assert.deepEqual(rescanned._aiScanBackup, expected);
    assert.deepEqual(restoreAiScannedMeta(rescanned), expected);
});

test('限量事件查询返回最近记录并保持叙事正序', () => {
    const oldContext = horaeManager.context;
    try {
        horaeManager.context = {
            chat: [
                message({ date: '2026/2/4', time: '09:00', event: '第一件事' }),
                message({ date: '2026/2/4', time: '12:00', event: '第二件事' }),
                message({ date: '2026/2/4', time: '16:00', event: '第三件事' }),
            ],
        };

        const events = horaeManager.getEvents(2);
        assert.deepEqual(events.map(entry => entry.event.summary), ['第二件事', '第三件事']);
        assert.deepEqual(events.map(entry => entry.messageIndex), [1, 2]);
    } finally {
        horaeManager.context = oldContext;
    }
});
