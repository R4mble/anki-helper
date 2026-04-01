const fs = require('fs/promises');
const path = require('path');

const APP_DIR = __dirname;
const SETTINGS_FILE = path.join(APP_DIR, 'app_settings.json');
const DEFAULT_SETTINGS_FILE = path.join(APP_DIR, 'app_default_setting.json');
const TERM_BANK_FILE = path.join(APP_DIR, 'public', 'term_meta_bank_1.json');
const OUTPUT_DIR = path.join(APP_DIR, 'reports');

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
    const fallback = {
        ankiConnectUrl: 'http://127.0.0.1:8765',
    };
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
    if (data.error) {
        throw new Error(data.error);
    }
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

function extractWholeTerm(raw) {
    const clean = stripHtml(raw)
        .replace(/\s+/g, ' ')
        .trim();
    return clean;
}

function pickFieldValue(note, preferredField) {
    const fields = note?.fields || {};
    if (preferredField && fields[preferredField]) {
        return fields[preferredField].value;
    }
    const fallbackFields = ['正面', 'Front', '单词', 'Word'];
    for (const name of fallbackFields) {
        if (fields[name]) return fields[name].value;
    }
    const firstKey = Object.keys(fields)[0];
    return firstKey ? fields[firstKey].value : '';
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

function sortOutsideRows(rows) {
    const rankScore = (rank) => (typeof rank === 'number' ? rank : Number.MAX_SAFE_INTEGER);
    return [...rows].sort((a, b) => {
        const diff = rankScore(b.rank) - rankScore(a.rank);
        if (diff !== 0) return diff;
        return b.ankiCount - a.ankiCount;
    });
}

// --- NEW SMART FALLBACK FUNCTION ---
function findRankWithFallback(term, rankMap) {
    // 1. Try exact match first
    if (rankMap.has(term)) {
        return rankMap.get(term);
    }

    const fallbacks = [];

    // 2. Handle 'ies' (e.g., parties -> party)
    if (term.endsWith('ies')) {
        fallbacks.push(term.slice(0, -3) + 'y'); 
    }
    // 3. Handle plurals and third-person verbs ('es', 's')
    else if (term.endsWith('es')) {
        fallbacks.push(term.slice(0, -2)); // boxes -> box
        fallbacks.push(term.slice(0, -1)); // notes -> note
    } else if (term.endsWith('s')) {
        fallbacks.push(term.slice(0, -1)); // cats -> cat
    }

    // 4. Handle past tense ('ed', 'd')
    if (term.endsWith('ed')) {
        fallbacks.push(term.slice(0, -2)); // jumped -> jump
        fallbacks.push(term.slice(0, -1)); // baked -> bake
    } else if (term.endsWith('d')) {
        fallbacks.push(term.slice(0, -1)); // heard -> hear
    }

    // 5. Handle gerunds/participles ('ing')
    if (term.endsWith('ing')) {
        fallbacks.push(term.slice(0, -3)); // playing -> play
        fallbacks.push(term.slice(0, -3) + 'e'); // making -> make
        
        // Handle double consonants (e.g., running -> run, stopping -> stop)
        if (term.length > 4 && term[term.length - 4] === term[term.length - 5]) {
            fallbacks.push(term.slice(0, -4));
        }
    }

    // 6. Check the dictionary for these fallback variations
    for (const fb of fallbacks) {
        if (rankMap.has(fb)) {
            return rankMap.get(fb);
        }
    }

    // If nothing matches
    return null;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const threshold = Number(args.threshold || 100);
    const query = String(args.query || '').trim() || 'deck:"#Listening::English::Word"';
    const field = String(args.field || '').trim() || '正面';

    const settings = await loadSettings();
    const ankiConnectUrl = settings.ankiConnectUrl || 'http://127.0.0.1:8765';

    // Added a try-catch block here to handle AnkiConnect connection errors gracefully
    let noteIds;
    try {
        noteIds = await invoke(ankiConnectUrl, 'findNotes', { query });
    } catch (err) {
        throw new Error(`Failed to connect to AnkiConnect. Is Anki open and the add-on installed? Details: ${err.message}`);
    }

    if (!Array.isArray(noteIds) || noteIds.length === 0) {
        throw new Error(`找不到符合查询条件的笔记，query=${query}`);
    }

    const notes = await invoke(ankiConnectUrl, 'notesInfo', { notes: noteIds });
    const termCount = new Map();
    const termDisplay = new Map();
    for (const note of notes) {
        const value = pickFieldValue(note, field);
        const term = extractWholeTerm(value);
        if (!term) continue;
        const key = term.toLowerCase();
        termCount.set(key, (termCount.get(key) || 0) + 1);
        if (!termDisplay.has(key)) {
            termDisplay.set(key, term);
        }
    }

    const termBankRaw = await fs.readFile(TERM_BANK_FILE, 'utf8');
    const termBank = JSON.parse(termBankRaw);
    const rankMap = buildTermFrequencyMap(termBank);

    const allRows = [];
    for (const [termKey, ankiCount] of termCount.entries()) {
        
        // --- UPDATED LINE: Using the smart fallback function ---
        const rank = findRankWithFallback(termKey, rankMap);
        
        const term = termDisplay.get(termKey) || termKey;
        allRows.push({
            word: term,
            ankiCount,
            rank,
            outOfTop: rank === null || rank > threshold,
        });
    }

    const outsideRows = sortOutsideRows(allRows.filter((x) => x.outOfTop));

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const jsonPath = path.join(OUTPUT_DIR, 'anki_words_outside_top20000.json');
    const txtPath = path.join(OUTPUT_DIR, 'anki_words_outside_top20000.txt');

    const payload = {
        threshold,
        query,
        field,
        analyzedNotes: notes.length,
        uniqueWords: allRows.length,
        outsideTopCount: outsideRows.length,
        rows: outsideRows,
    };
    await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

    const lines = outsideRows.map((row, idx) => {
        const rankText = row.rank === null ? 'N/A' : row.rank;
        return `${idx + 1}\t${row.word}\tanki_count=${row.ankiCount}\trank=${rankText}`;
    });
    await fs.writeFile(txtPath, lines.join('\n'), 'utf8');

    console.log(`分析完成: ${notes.length} 条笔记, ${allRows.length} 个唯一词`);
    console.log(`20000 开外词数: ${outsideRows.length}`);
    console.log(`JSON 输出: ${jsonPath}`);
    console.log(`TXT 输出: ${txtPath}`);
    console.log('前 20 条（倒排）:');
    outsideRows.slice(0, 20).forEach((row, idx) => {
        const rankText = row.rank === null ? 'N/A' : row.rank;
        console.log(`${idx + 1}. ${row.word} | rank=${rankText} | anki_count=${row.ankiCount}`);
    });
}

main().catch((error) => {
    console.error(`执行失败: ${error.message}`);
    process.exit(1);
});