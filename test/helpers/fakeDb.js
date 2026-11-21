// Минимальный in-memory фейк jembadb для Reader/Indexer/loadIndexFromDump.
// Поддерживает: select({table, where}), esc, create, insert, close, freeMemory, open, openAll.
class FakeDb {
    constructor() {
        this.tables = new Map();       // table -> rows[]
        this.hashes = new Map();       // table -> Set<field> (созданные hash-индексы)
        this.created = [];             // {table, index?, hash?}
        this.inserted = [];            // {table, rows}
    }

    esc(v) {
        return `'${String(v).replace(/'/g, "''")}'`;
    }

    async select({ table, where }) {
        const rows = this.tables.get(table) || [];
        if (!where) return rows.slice();

        // поддержка @@hash('_uid', 'x') и @@hash('_uid', ['a','b'])
        // esc(['a','b']) -> "'a,b'" (mson-массив в кавычках)
        const m = where.match(/@@hash\('([^']+)',\s*(.+?)\)$/);
        if (m) {
            const [, field, raw] = m;
            let key = raw.trim();
            let values;
            if (key.startsWith('[')) {
                values = key.slice(1, -1).split(',').map(s => s.trim().replace(/^'|'$/g, ''));
            } else {
                key = key.replace(/^'|'$/g, '');
                values = key.includes(',') ? key.split(',').map(s => s.trim()) : [key];
            }
            const set = new Set(values);
            return rows.filter(r => set.has(r[field]));
        }

        // @@id('x') или @@id('1','2','3') / @@id('1,2,3')
        const mid = where.match(/@@id\((.+?)\)$/);
        if (mid) {
            const key = mid[1].trim().replace(/^'|'$/g, '');
            const hasComma = key.includes(',');
            const set = hasComma ? new Set(key.split(',').map((s) => s.trim().replace(/^'|'$/g, ''))) : null;
            return rows.filter((r) => (hasComma ? set.has(String(r.id)) : String(r.id) === key));
        }

        return rows.slice();
    }

    async create(opts) {
        this.created.push(opts);
        if (opts.table && !this.tables.has(opts.table))
            this.tables.set(opts.table, []);
        if (opts.in && opts.hash) {
            if (!this.hashes.has(opts.in)) this.hashes.set(opts.in, new Set());
            this.hashes.get(opts.in).add(opts.hash.field);
        }
    }

    async insert({ table, rows }) {
        const arr = this.tables.get(table) || [];
        arr.push(...rows);
        this.tables.set(table, arr);
        this.inserted.push({ table, rows });
    }

    async close() {}
    async open() {}
    async openAll() {}
    async freeMemory() {}
}

module.exports = FakeDb;