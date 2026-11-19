<template>
    <div class="tile-root">
        <LoadingMessage :message="loadingMessage" />

        <div class="tile-head">
            <div class="row items-center no-wrap">
                <DivBtn size="28" icon="la la-arrow-left" @meClick="goHome" />
                <div class="q-ml-sm tile-search-title">Поиск: {{ q }}</div>
                <div class="q-ml-md">
                    <DivBtn size="28" icon="la la-search" @meClick="reload">поиск</DivBtn>
                </div>
                <div v-if="total >= 0" class="q-ml-md text-grey-7">
                    найдено: {{ total }}
                </div>
            </div>
            <TileSearchBar class="q-mt-sm" />
        </div>

        <div v-if="error" class="text-red q-pa-md">
            {{ error }}
        </div>
        <div v-else-if="!loadingMessage && !books.length" class="text-grey q-pa-lg">
            Ничего не найдено
        </div>
        <div v-else class="tile-list">
            <div v-for="b in books" :key="b._uid" class="tile-list-item" @click="openBook(b)">
                {{ line(b) }}
            </div>
        </div>

        <div v-if="total > limit" class="tile-pager row items-center justify-center q-mb-md">
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
import TileSearchBar from './TileSearchBar.vue';

const componentOptions = {
    components: {
        LoadingMessage,
        DivBtn,
        TileSearchBar,
    },
    watch: {
        $route() {
            this.onRoute();
        },
    },
};
class TileSearch {
    _options = componentOptions;

    limit = 40;
    q = '';
    books = [];
    total = 0;
    offset = 0;
    loadingMessage = '';
    error = '';
    loadFlag = 0;

    get page() {
        return Math.floor(this.offset / this.limit) + 1;
    }

    get pageCount() {
        return Math.max(1, Math.ceil(this.total / this.limit));
    }

    created() {
        this.api = this.$root.api;
    }

    mounted() {
        this.onRoute();
    }

    onRoute() {
        if (!this.$route.path.startsWith('/tile/search'))
            return;

        const q = String(this.$route.query.q || '').trim();
        if (q !== this.q) {
            this.q = q;
            this.offset = 0;
            this.reload();
        }
    }

    reload() {
        if (!this.q)
            return;

        const flag = ++this.loadFlag;
        this.loadingMessage = 'Загрузка...';
        this.error = '';
        (async() => {
            try {
                const result = await this.api.bookSearchAny(this.q, this.limit, this.offset);
                if (flag !== this.loadFlag)
                    return;
                this.books = (result.found || []);
                this.total = (result.totalFound || 0);
            } catch (e) {
                if (flag !== this.loadFlag)
                    return;
                this.error = e.message;
                this.books = [];
                this.total = 0;
            } finally {
                if (flag !== this.loadFlag)
                    return;
                this.loadingMessage = '';
                if (this.$el)
                    this.$el.scrollTop = 0;
            }
        })();
    }

    prev() {
        this.offset = Math.max(0, this.offset - this.limit);
        this.reload();
    }

    next() {
        this.offset += this.limit;
        this.reload();
    }

    line(b) {
        const parts = [];
        if (b.author)
            parts.push(b.author);
        if (b.series)
            parts.push(b.series);
        if (b.title)
            parts.push(b.title);
        const extra = [];
        if (b.year)
            extra.push(b.year);
        if (b.lang)
            extra.push(b.lang);
        if (b.ext)
            extra.push(b.ext);
        if (b.librate)
            extra.push(`★${b.librate}`);
        if (extra.length)
            parts.push(extra.join(', '));
        return parts.join(' / ');
    }

    openBook(b) {
        this.$router.push(`/tile/book/${encodeURIComponent(b._uid)}`);
    }

    goHome() {
        this.$router.push('/tile');
    }
}

export default vueComponent(TileSearch);
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

.tile-search-title {
    font-size: 18px;
    font-weight: bold;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 500px;
}

.tile-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 16px;
}

.tile-list-item {
    background: #ffffff;
    border-radius: 6px;
    box-shadow: 1px 2px 6px rgba(0, 0, 0, 0.25);
    padding: 9px 12px;
    font-size: 13px;
    line-height: 18px;
    color: #333333;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    transition: transform 0.15s linear, box-shadow 0.15s linear;
}

.tile-list-item:hover {
    transform: translateY(-1px);
    box-shadow: 1px 4px 12px rgba(0, 0, 0, 0.35);
}
</style>
