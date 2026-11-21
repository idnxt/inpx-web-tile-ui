<template>
    <div class="tile-root">
        <LoadingMessage :message="loadingMessage" />

        <div class="tile-head">
            <div class="row items-center no-wrap">
                <DivBtn size="28" icon="la la-arrow-left" @meClick="goHome" />
                <div class="q-ml-sm tile-section-title">{{ title }}</div>
                <div v-if="!loadingMessage" class="q-ml-md text-grey-7">всего: {{ total }}</div>
                <a class="q-ml-md tile-head-profile" :href="'#/tile/settings'">
                    <i class="la la-cog" />
                    <span class="q-ml-xs">{{ profile || 'настройки' }}</span>
                    <q-tooltip :delay="1500" anchor="bottom middle" content-style="font-size: 80%">
                        Профиль и настройки
                    </q-tooltip>
                </a>
            </div>
        </div>

        <div v-if="error" class="text-red q-pa-md">
            {{ error }}
        </div>
        <div v-else-if="!loadingMessage && !books.length" class="text-grey q-pa-lg">
            {{ emptyText }}
        </div>
        <div v-else class="tile-list">
            <div v-for="b in books" :key="b._uid" class="tile-list-row">
                <a class="tile-list-cover" :href="`#/tile/book/${encodeURIComponent(b._uid)}`">
                    <img v-if="covers[b._uid]" :src="covers[b._uid]" alt="" loading="lazy" />
                    <div v-else class="tile-list-cover-ph"><i class="la la-book" /></div>
                </a>
                <div class="tile-list-info">
                    <a class="tile-list-title" :href="`#/tile/book/${encodeURIComponent(b._uid)}`">{{ b.title }}</a>
                    <div class="tile-list-sub">
                        <span v-if="b.author">{{ b.author }}</span>
                        <span v-if="b.year"> · {{ b.year }}</span>
                        <span v-if="type === 'read' && b.readTime" class="tile-list-note"> · прочитано {{ fmtDate(b.readTime) }}</span>
                    </div>
                    <template v-if="type === 'rated'">
                        <div class="tile-list-rate"><TileStars :rating="b.rating" :size="14" /></div>
                        <div v-if="b.review" class="tile-list-review">{{ b.review }}</div>
                    </template>
                </div>
            </div>

            <div v-if="books.length < total" class="row justify-center q-mt-md q-mb-md">
                <DivBtn size="28" :disabled="loadingMore" @meClick="loadMore">показать ещё</DivBtn>
            </div>
        </div>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import LoadingMessage from '../Search/LoadingMessage/LoadingMessage.vue';
import DivBtn from '../share/DivBtn.vue';
import TileStars from './TileStars.vue';

const componentOptions = {
    components: {
        LoadingMessage,
        DivBtn,
        TileStars,
    },
    watch: {
        //keep-alive: компонент не пересоздаётся при повторном входе — перечитываем список
        //также ловит переход между /tile/read и /tile/rated
        $route() {
            this.reload();
        },
    },
};
class TileUserList {
    _options = componentOptions;

    books = [];
    covers = {};
    total = 0;
    offset = 0;
    limit = 50;
    loadingMessage = '';
    error = '';
    loadingMore = false;

    get profile() {
        return (this.$store.state.settings.tileProfile || '');
    }

    //маршрут определяет список: /tile/read | /tile/rated
    get type() {
        return (this.$route.path === '/tile/rated' ? 'rated' : 'read');
    }

    get title() {
        return (this.type === 'rated' ? 'Оценённые' : 'Прочитанные');
    }

    get emptyText() {
        return (this.type === 'rated' ? 'Оценок пока нет' : 'Отметок «прочитано» пока нет');
    }

    created() {
        this.api = this.$root.api;
    }

    mounted() {
        this.reload();
    }

    goHome() {
        this.$router.push('/tile');
    }

    async reload() {
        this.error = '';
        this.books = [];
        this.covers = {};
        this.total = 0;
        this.offset = 0;
        this.loadingMessage = 'Загрузка...';
        try {
            await this.loadPage();
        } catch (e) {
            this.error = e.message;
        } finally {
            this.loadingMessage = '';
        }
    }

    async loadPage() {
        this.loadingMore = true;
        try {
            if (!this.profile)
                throw new Error('профиль не задан — задайте его в настройках');

            const res = (this.type === 'rated')
                ? await this.api.getRatedList(this.profile, this.offset, this.limit)
                : await this.api.getReadList(this.profile, this.offset, this.limit);
            const fresh = (res.books || []);
            this.books = this.books.concat(fresh);
            this.total = (res.total != null ? res.total : this.books.length);
            this.offset = this.books.length;

            const uids = fresh.map((b) => b._uid);
            if (uids.length) {
                const cr = await this.api.getBookCovers(uids);
                for (const [k, v] of Object.entries(cr.covers || {}))
                    this.covers[k] = v;
            }
        } finally {
            this.loadingMore = false;
        }
    }

    async loadMore() {
        try {
            await this.loadPage();
        } catch (e) {
            this.error = e.message;
        }
    }

    fmtDate(t) {
        const d = new Date(t);
        if (isNaN(d.getTime()))
            return '';
        return d.toLocaleDateString('ru-RU');
    }
}

export default vueComponent(TileUserList);
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
    font-size: 20px;
    font-weight: bold;
}

.tile-head-profile {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 10px;
    background: #ffffff;
    border-radius: 4px;
    color: #1976d2;
    font-size: 13px;
    text-decoration: none;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}

a.tile-head-profile:hover {
    background: #e3f2fd;
}

.tile-list {
    padding: 12px 16px;
}

.tile-list-row {
    display: flex;
    gap: 10px;
    background: #ffffff;
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

.tile-list-cover {
    flex: 0 0 auto;
    width: 64px;
    height: 86px;
    background: #e0e0e0;
    border-radius: 4px;
    overflow: hidden;
    display: block;
}

.tile-list-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.tile-list-cover-ph {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #999999;
    font-size: 22px;
}

.tile-list-info {
    flex: 1 1 auto;
    min-width: 0;
}

.tile-list-title {
    color: #1976d2;
    text-decoration: none;
    font-size: 14px;
    font-weight: bold;
    line-height: 18px;
}

a.tile-list-title:hover {
    text-decoration: underline;
}

.tile-list-sub {
    margin-top: 2px;
    font-size: 12px;
    color: #666666;
}

.tile-list-note {
    color: #888888;
}

.tile-list-rate {
    margin-top: 4px;
}

.tile-list-review {
    margin-top: 4px;
    font-size: 12px;
    color: #444444;
    white-space: pre-wrap;
}
</style>
