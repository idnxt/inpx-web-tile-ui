<template>
    <div class="tile-root">
        <LoadingMessage :message="loadingMessage" />

        <div class="tile-head">
            <div class="row items-center no-wrap">
                <a class="tile-home-logo" href="#/">
                    <img src="../Search/assets/logo.png" />
                    <q-tooltip :delay="1500" anchor="bottom middle" content-style="font-size: 80%" max-width="400px">
                        Перейти к поиску
                    </q-tooltip>
                </a>
                <div class="q-ml-sm tile-home-title">{{ collection }}</div>
                <div class="q-ml-md">
                    <DivBtn size="28" icon="la la-refresh" :disabled="loading" @meClick="refresh">обновить</DivBtn>
                </div>
            </div>
            <TileSearchBar class="q-mt-sm" />
        </div>

        <div v-if="error" class="text-red q-pa-md">
            {{ error }}
        </div>

        <div v-if="data.seed" class="tile-body">
            <TileFeed title="Новые книги" :books="data.new" :covers="covers" />
            <TileFeed title="Лучшие книги" :books="data.top" :covers="covers" />
            <TileFeed title="Серии: новые" :books="seriesNew" :covers="covers" />
            <TileFeed title="Серии: лучшие" :books="seriesTop" :covers="covers" />
            <template v-for="(f, i) in data.years" :key="`year-${i}`">
                <TileFeed :title="`${f.year}`" :title-href="sectionLink('year', f.year)" :books="f.books" :covers="covers" />
            </template>
            <template v-for="(g, i) in data.genres" :key="`genre-${i}`">
                <TileFeed :title="g.name" suffix=": новые" :title-href="sectionLink('genre', g.value)" :books="g.new" :covers="covers" />
                <TileFeed :title="g.name" suffix=": лучшие" :title-href="sectionLink('genre', g.value)" :subgenres="genreSubs(g.value)" :books="g.best" :covers="covers" />
            </template>
            <TileFeed title="Авторы" :books="authorCards" :covers="covers" />
        </div>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import LoadingMessage from '../Search/LoadingMessage/LoadingMessage.vue';
import DivBtn from '../share/DivBtn.vue';
import TileFeed from './TileFeed.vue';
import TileSearchBar from './TileSearchBar.vue';

const componentOptions = {
    components: {
        LoadingMessage,
        DivBtn,
        TileFeed,
        TileSearchBar,
    },
};
class TileHome {
    _options = componentOptions;

    data = {};
    covers = {};
    seriesNew = [];
    seriesTop = [];
    authorCards = [];
    genreSections = [];
    loadingMessage = '';
    error = '';

    get loading() {
        return !!this.loadingMessage;
    }

    get collection() {
        const config = this.$store.state.config;
        if (!config || !config.dbConfig || !config.dbConfig.inpxInfo)
            return '';
        return config.dbConfig.inpxInfo.collection.split('\n')[0].trim();
    }

    created() {
        this.api = this.$root.api;
    }

    mounted() {
        if (!this.data.seed)
            this.refresh();
    }

    refresh() {
        this.error = '';
        this.data = {};
        this.covers = {};
        this.seriesNew = [];
        this.seriesTop = [];
        this.authorCards = [];
        this.loadingMessage = 'Загрузка...';
        this.loadGenreTree();
        const seed = Math.floor(Math.random() * 0x7fffffff);

        (async() => {
            try {
                const result = await this.api.getTileHome(seed);
                this.data = result;

                this.seriesNew = result.seriesNew.map((c) => ({
                    book: c.book,
                    label: `(${c.count}) ${c.series}`,
                    link: `/tile/section/series/${encodeURIComponent(c.series)}`,
                }));
                this.seriesTop = result.seriesTop.map((c) => ({
                    book: c.book,
                    label: `(${c.count}) ${c.series}`,
                    link: `/tile/section/series/${encodeURIComponent(c.series)}`,
                }));
                this.authorCards = result.authors
                    .filter((a) => a.book)
                    .map((a) => ({
                        book: a.book,
                        label: `${a.name} (${a.avg.toFixed(1)} | ${a.count})`,
                        link: `/tile/section/author/${a.id}`,
                    }));

                //все обложки одним запросом
                const uids = this.allUids();
                if (uids.length) {
                    const res = await this.api.getBookCovers(uids);
                    this.covers = (res.covers || {});
                }
            } catch (e) {
                this.error = e.message;
            } finally {
                this.loadingMessage = '';
            }
        })();
    }

    allUids() {
        const set = new Set();
        const add = (books) => {
            for (const b of (books || [])) {
                if (b && b._uid)
                    set.add(b._uid);
            }
        };

        add(this.data.new);
        add(this.data.top);
        for (const c of this.seriesNew.concat(this.seriesTop))
            add([c.book]);
        for (const f of (this.data.years || []))
            add(f.books);
        for (const g of (this.data.genres || [])) {
            add(g.new);
            add(g.best);
        }
        for (const c of this.authorCards)
            add([c.book]);

        return Array.from(set);
    }

    sectionLink(type, value) {
        return `#/tile/section/${type}/${encodeURIComponent(value)}`;
    }

    async loadGenreTree() {
        if (this.genreSections.length)
            return;

        try {
            const tree = await this.api.getGenreTree();
            this.genreSections = tree.genreTree.map((s) => ({
                name: s.name,
                value: s.value.map((g) => g.value).join(','),
                genres: s.value,
            }));
        } catch (e) {
            //не критично
        }
    }

    genreSubs(value) {
        const section = this.genreSections.find((s) => s.value === value);
        return (section ? section.genres : []);
    }
}

export default vueComponent(TileHome);
</script>

<style scoped>
.tile-root {
    position: relative;
    height: 100%;
    overflow: auto;
    background: #f5f5f5;
}

.tile-head {
    position: sticky;
    top: 0;
    z-index: 10;
    background: #e0f2f1;
    padding: 8px 16px;
}

.tile-home-logo img {
    height: 32px;
    width: 32px;
}

.tile-home-title {
    font-size: 20px;
    font-weight: bold;
}

.tile-body {
    padding: 12px 16px;
}
</style>
