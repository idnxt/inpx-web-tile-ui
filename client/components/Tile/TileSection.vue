<template>
    <div class="tile-root">
        <LoadingMessage :message="loadingMessage" />

        <div class="tile-head">
            <div class="row items-center no-wrap">
                <DivBtn size="28" icon="la la-arrow-left" @meClick="goHome" />
                <div class="q-ml-sm tile-section-title">{{ title }}</div>
                <div class="q-ml-md">
                    <q-btn-toggle
                        v-model="sort"
                        class="q-mr-sm"
                        toggle-color="primary"
                        :options="sortOptions"
                        push
                        no-caps
                        rounded
                    />
                </div>
                <div v-if="total > 0" class="text-grey-7">
                    найдено: {{ total }}
                </div>
            </div>
            <TileSearchBar class="q-mt-sm" />
        </div>

        <div v-if="type === 'genre' && subgenres.length" class="tile-subhead row items-center">
            <template v-for="(g, i) in subgenres" :key="`sub-${i}`">
                <span class="tile-subhead-sep">/</span>
                <a :href="`#/tile/section/genre/${encodeURIComponent(g.value)}`" class="tile-subhead-link">{{ g.name }}</a>
            </template>
        </div>

        <div v-if="type === 'author'" class="tile-authorbox">
            <div v-if="bioDisabled" class="tile-block-note">Биографии авторов недоступны</div>
            <div v-else-if="bioLoading" class="tile-block-note">Загрузка биографии...</div>
            <div v-else-if="authorBio" class="row items-start tile-authorbox-in">
                <img v-if="authorPhoto" :src="authorPhoto" class="tile-author-photo" alt="" @error="authorPhoto = ''" />
                <div class="col tile-author-bio" v-html="authorBio" />
            </div>
            <div v-else class="tile-block-note">Биография не найдена</div>
        </div>

        <div v-if="error" class="text-red q-pa-md">
            {{ error }}
        </div>
        <div v-else-if="isSeriesFeeds">
            <div v-if="!total" class="text-grey q-pa-lg">
                Ничего не найдено
            </div>
            <div v-else class="tile-series-feeds">
                <TileFeed
                    v-for="f in seriesFeeds"
                    :key="f.series"
                    :title="`${f.series} (${f.count})`"
                    :title-href="seriesLink(f.series)"
                    :books="f.books"
                    :covers="covers"
                />
                <TileFeed
                    v-if="noSeries.length"
                    title="Без серии"
                    :books="noSeries"
                    :covers="covers"
                />
            </div>
        </div>
        <div v-else-if="!loadingMessage && !books.length" class="text-grey q-pa-lg">
            Ничего не найдено
        </div>
        <div v-else class="tile-grid">
            <TileCard
                v-for="b in books"
                :key="b._uid"
                :book="b"
                :cover="covers[b._uid]"
            />
        </div>

        <div v-if="!isSeriesFeeds && total > limit" class="tile-pager row items-center justify-center q-mb-md">
            <DivBtn size="28" icon="la la-angle-left" :disabled="offset <= 0" @meClick="prev" />
            <div class="q-px-md text-grey-7">
                стр. {{ page }} из {{ pageCount }}
            </div>
            <DivBtn size="28" icon="la la-angle-right" :disabled="offset + books.length >= total" @meClick="next" />
        </div>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import LoadingMessage from '../Search/LoadingMessage/LoadingMessage.vue';
import DivBtn from '../share/DivBtn.vue';
import TileCard from './TileCard.vue';
import TileFeed from './TileFeed.vue';
import TileSearchBar from './TileSearchBar.vue';

const typeNames = {
    genre: 'Жанр',
    author: 'Автор',
    series: 'Серия',
    year: 'Год',
};

const componentOptions = {
    components: {
        LoadingMessage,
        DivBtn,
        TileCard,
        TileFeed,
        TileSearchBar,
    },
    watch: {
        $route() {
            this.onRoute();
        },
        sort() {
            this.offset = 0;
            this.reload();
        },
    },
};
class TileSection {
    _options = componentOptions;

    limit = 50;
    type = '';
    value = '';
    books = [];
    covers = {};
    total = 0;
    offset = 0;
    sort = 'new';
    authorName = '';
    authorHash = '';
    authorBio = '';
    authorPhoto = '';
    bioDisabled = false;
    bioLoading = false;
    authorBioLoadedFor = '';
    genreMap = new Map();
    genreSections = [];
    loadingMessage = '';
    error = '';
    reloadGeneration = 0;
    seriesFeeds = [];
    noSeries = [];

    get isSeriesFeeds() {
        return (this.type === 'author' && this.sort === 'series');
    }

    get sortOptions() {
        if (this.type === 'author')
            return [
                {label: 'поступление', value: 'new'},
                {label: 'серии', value: 'series'},
                {label: 'год', value: 'year'},
                {label: 'популярность', value: 'rate'},
            ];
        if (this.type === 'series')
            return [
                {label: 'порядок', value: 'serno'},
                {label: 'новые', value: 'new'},
            ];
        return [
            {label: 'новые', value: 'new'},
            {label: 'оценки', value: 'rate'},
        ];
    }

    get loading() {
        return !!this.loadingMessage;
    }

    get page() {
        return Math.floor(this.offset / this.limit) + 1;
    }

    get pageCount() {
        return Math.max(1, Math.ceil(this.total / this.limit));
    }

    get title() {
        let v = this.value;
        if (this.type === 'genre') {
            const section = this.genreSections.find((s) => s.value === v);
            if (section) {
                v = section.name;
            } else if (this.genreMap.size) {
                v = v.split(',').map((c) => (this.genreMap.get(c.trim()) || c.trim())).join(', ');
            }
        } else if (this.type === 'author') {
            v = (this.authorName || v);
        }
        const name = (typeNames[this.type] || this.type);
        return `${name}: ${v}`;
    }

    get subgenres() {
        if (this.type !== 'genre')
            return [];

        const v = this.value;
        const section = this.genreSections.find((s) => s.value === v);
        if (section)
            return section.genres;

        //единичный жанр — ищем раздел, которому он принадлежит
        const parts = v.split(',');
        const owner = this.genreSections.find((s) => s.genres.some((g) => parts.includes(g.value)));
        return (owner ? owner.genres : []);
    }

    created() {
        this.api = this.$root.api;
        this.loadGenreNames();
    }

    mounted() {
        this.onRoute();
    }

    async loadGenreNames() {
        try {
            const tree = await this.api.getGenreTree();
            const map = new Map();
            const sections = [];
            for (const section of tree.genreTree) {
                for (const g of section.value)
                    map.set(g.value, g.name);
                sections.push({
                    name: section.name,
                    value: section.value.map((g) => g.value).join(','),
                    genres: section.value,
                });
            }
            this.genreMap = map;
            this.genreSections = sections;
        } catch (e) {
            //не критично
        }
    }

    onRoute() {
        if (!this.$route.path.startsWith('/tile/section/'))
            return;

        const type = this.$route.params.type;
        const value = this.$route.params.value;
        if (!type || !value) {
            this.$router.replace('/tile');
            return;
        }

        if (type !== this.type || value !== this.value) {
            this.type = type;
            this.value = value;
            this.offset = 0;
            this.sort = (type === 'series' ? 'serno' : 'new');
            this.authorName = '';
            this.authorHash = '';
            this.authorBio = '';
            this.authorPhoto = '';
            this.authorBioLoadedFor = '';
            this.seriesFeeds = [];
            this.noSeries = [];
            this.reload();
        }
    }

    async reload() {
        if (!this.type)
            return;

        const generation = ++this.reloadGeneration;
        this.loadingMessage = 'Загрузка...';
        this.error = '';
        try {
            const result = await this.api.getTileSection(this.type, this.value, this.offset, this.limit, this.sort);
            if (generation !== this.reloadGeneration)
                return;
            this.books = (result.books || []);
            this.total = (result.total || 0);
            this.authorName = (this.type === 'author' ? (result.author || '') : '');
            this.authorHash = (this.type === 'author' ? (result.authorHash || '') : '');

            if (this.isSeriesFeeds) {
                this.seriesFeeds = (result.seriesFeeds || []);
                this.noSeries = (result.noSeries || []);
            } else {
                this.seriesFeeds = [];
                this.noSeries = [];
            }

            if (this.type === 'author')
                this.loadAuthorBio();

            this.covers = {};
            let uids;
            if (this.isSeriesFeeds) {
                uids = [];
                for (const f of this.seriesFeeds)
                    uids.push(...f.books.map((b) => b._uid));
                uids.push(...this.noSeries.map((b) => b._uid));
            } else {
                uids = this.books.map((b) => b._uid);
            }
            if (uids.length) {
                const res = await this.api.getBookCovers(uids);
                if (generation !== this.reloadGeneration)
                    return;
                this.covers = (res.covers || {});
            }
        } catch (e) {
            if (generation !== this.reloadGeneration)
                return;
            this.error = e.message;
            this.books = [];
            this.total = 0;
        } finally {
            if (generation !== this.reloadGeneration)
                return;
            this.loadingMessage = '';
            if (this.$el)
                this.$el.scrollTop = 0;
        }
    }

    prev() {
        this.offset = Math.max(0, this.offset - this.limit);
        this.reload();
    }

    next() {
        this.offset += this.limit;
        this.reload();
    }

    get config() {
        return this.$store.state.config;
    }

    async loadAuthorBio() {
        if (this.type !== 'author' || !this.authorHash)
            return;

        const features = (this.config.features || {});
        this.bioDisabled = !features.authorsBioEnabled;
        if (this.bioDisabled)
            return;

        if (this.authorBioLoadedFor === this.authorHash)
            return;

        const hash = this.authorHash;
        this.authorBioLoadedFor = hash;
        this.bioLoading = true;
        this.authorBio = '';
        this.authorPhoto = '';
        try {
            const res = await this.api.getAuthorBio(hash);
            if (hash !== this.authorHash)
                return;

            this.authorBio = ((res && res.bio) || '');
            if (this.authorBio && res.hasPhoto !== false)
                this.authorPhoto = `${(this.config.rootPathStatic || '')}/author/photo?hash=${encodeURIComponent(hash)}`;
        } catch (e) {
            //био не критично
        } finally {
            if (hash === this.authorHash)
                this.bioLoading = false;
        }
    }

    seriesLink(v) {
        return `#/tile/section/series/${encodeURIComponent(v)}`;
    }

    goHome() {
        this.$router.push('/tile');
    }
}

export default vueComponent(TileSection);
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

.tile-section-title {
    font-size: 18px;
    font-weight: bold;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 600px;
}

.tile-subhead {
    padding: 0 16px 4px 16px;
    background: #e0f2f1;
}

.tile-subhead-sep {
    font-size: 12px;
    color: #999999;
    margin: 0 4px;
}

.tile-subhead-link {
    font-size: 12px;
    color: #1976d2;
    text-decoration: none;
}

.tile-subhead-link:hover {
    text-decoration: underline;
}

.tile-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    padding: 12px 16px;
}

.tile-series-feeds {
    padding: 12px 16px;
}

.tile-authorbox {
    background: #e0f2f1;
}

.tile-authorbox-in {
    padding: 8px 16px 10px 16px;
}

.tile-block-note {
    font-size: 12px;
    color: #888888;
    padding: 6px 16px;
}

.tile-author-photo {
    flex: 0 0 auto;
    width: 90px;
    height: 120px;
    object-fit: cover;
    border-radius: 4px;
    margin-right: 12px;
    box-shadow: 1px 2px 6px rgba(0, 0, 0, 0.25);
}

.tile-author-bio {
    font-size: 13px;
    line-height: 1.5;
    color: #333333;
    max-width: 900px;
}

.tile-author-bio ::v-deep p {
    margin: 0 0 6px 0;
}
</style>
