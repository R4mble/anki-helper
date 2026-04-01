const fs = require('fs/promises');
const path = require('path');

const APP_DIR = __dirname;
const SETTINGS_FILE = path.join(APP_DIR, 'app_settings.json');
const DEFAULT_SETTINGS_FILE = path.join(APP_DIR, 'app_default_setting.json');
const TERM_BANK_FILE = path.join(APP_DIR, 'public', 'term_meta_bank_1.json');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const item = argv[i];
        if (!item.startsWith('--')) continue;
        const key = item.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            args[key] = true;
            continue;
        }
        args[key] = next;
        i += 1;
    }
    return args;
}

async function loadSettings() {
    const fallback = { ankiConnectUrl: 'http://127.0.0.1:8765' };
    try {
        const file = await fs.readFile(SETTINGS_FILE, 'utf8');
        return { ...fallback, ...JSON.parse(file) };
    } catch {
        try {
            const file = await fs.readFile(DEFAULT_SETTINGS_FILE, 'utf8');
            return { ...fallback, ...JSON.parse(file) };
        } catch {
            return fallback;
        }
    }
}

async function invoke(ankiConnectUrl, action, params = {}) {
    const resp = await fetch(ankiConnectUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action,
            version: 6,
            params,
        }),
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data.result;
}

function stripHtml(raw) {
    return String(raw || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\[sound:[^\]]+\]/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTerm(raw) {
    return stripHtml(raw).replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildTermFrequencyMap(termBank) {
    const map = new Map();
    for (const row of termBank) {
        if (!Array.isArray(row) || row.length === 0) continue;
        const term = String(row[0] || '').toLowerCase().trim();
        if (!term) continue;
        let rank = null;
        for (const piece of row) {
            if (piece && typeof piece === 'object' && typeof piece.frequency === 'number') {
                rank = piece.frequency;
                break;
            }
        }
        if (typeof rank !== 'number') continue;
        const prev = map.get(term);
        if (prev === undefined || rank < prev) {
            map.set(term, rank);
        }
    }
    return map;
}

function findRankWithSuffixFallback(term, rankMap) {
    if (!term) return null;
    if (rankMap.has(term)) return rankMap.get(term);

    // 用户要求：找不到时尝试去掉末尾 d/s/ed/es
    const candidates = [];
    if (term.endsWith('ed') && term.length > 3) candidates.push(term.slice(0, -2));
    if (term.endsWith('es') && term.length > 3) candidates.push(term.slice(0, -2));
    if (term.endsWith('d') && term.length > 2) candidates.push(term.slice(0, -1));
    if (term.endsWith('s') && term.length > 2) candidates.push(term.slice(0, -1));

    for (const c of candidates) {
        if (rankMap.has(c)) return rankMap.get(c);
    }
    return null;
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const query = String(args.query || '').trim() || 'deck:"#Listening::English::Word"';
    const sourceField = String(args.sourceField || '').trim() || '正面';
    const targetField = String(args.targetField || '').trim() || '单词词频';
    const apply = Boolean(args.apply);
    const notFoundText = String(args.notFoundText || 'N/A');

    const settings = await loadSettings();
    const ankiConnectUrl = settings.ankiConnectUrl || 'http://127.0.0.1:8765';

    const noteIds = await invoke(ankiConnectUrl, 'findNotes', { query });
    if (!Array.isArray(noteIds) || noteIds.length === 0) {
        throw new Error(`未找到笔记，query=${query}`);
    }

    const termBankRaw = await fs.readFile(TERM_BANK_FILE, 'utf8');
    const rankMap = buildTermFrequencyMap(JSON.parse(termBankRaw));

    let inspected = 0;
    let willUpdate = 0;
    let updated = 0;
    let notFound = 0;
    const preview = [];

    for (const group of chunk(noteIds, 300)) {
        const notes = await invoke(ankiConnectUrl, 'notesInfo', { notes: group });
        for (const note of notes) {
            inspected += 1;
            const sourceVal = note.fields?.[sourceField]?.value;
            if (sourceVal === undefined) continue;
            const term = normalizeTerm(sourceVal);
            if (!term) continue;

            const rank = findRankWithSuffixFallback(term, rankMap);
            const finalValue = rank === null ? notFoundText : String(rank);
            if (rank === null) notFound += 1;

            const oldValue = String(note.fields?.[targetField]?.value || '').trim();
            if (oldValue === finalValue) continue;

            willUpdate += 1;
            if (preview.length < 20) {
                preview.push({
                    noteId: note.noteId,
                    term,
                    oldValue,
                    newValue: finalValue,
                });
            }

            if (apply) {
                await invoke(ankiConnectUrl, 'updateNoteFields', {
                    note: {
                        id: note.noteId,
                        fields: {
                            [targetField]: finalValue,
                        },
                    },
                });
                updated += 1;
            }
        }
    }

    console.log(`查询条件: ${query}`);
    console.log(`源字段: ${sourceField}`);
    console.log(`目标字段: ${targetField}`);
    console.log(`检查笔记数: ${inspected}`);
    console.log(`未命中词频数: ${notFound}`);
    console.log(`需要更新: ${willUpdate}`);
    console.log(`实际更新: ${updated}${apply ? '' : ' (dry-run, 未写回)'}`);
    console.log('示例（前20条）:');
    for (const item of preview) {
        console.log(
            `note=${item.noteId} | term=${item.term} | old="${item.oldValue}" -> new="${item.newValue}"`
        );
    }
    if (!apply) {
        console.log('提示: 如需真正写回，请加参数 --apply');
    }
}

main().catch((error) => {
    console.error(`执行失败: ${error.message}`);
    process.exit(1);
});
