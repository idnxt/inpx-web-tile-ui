<template>
    <div class="tile-root">
        <LoadingMessage :message="loadingMessage" />

        <div class="tile-head">
            <div class="row items-center no-wrap">
                <DivBtn size="28" icon="la la-arrow-left" @meClick="goHome" />
                <div class="q-ml-sm tile-section-title">Настройки</div>
            </div>
        </div>

        <div v-if="error" class="text-red q-pa-md">
            {{ error }}
        </div>
        <div v-else class="tile-settings">
            <div class="tile-set-block">
                <div class="tile-block-head">Профиль</div>
                <div class="row items-center q-mt-sm">
                    <input
                        v-model="profileInput"
                        class="tile-set-input"
                        placeholder="имя профиля (текст или цифры)"
                    />
                    <DivBtn class="q-ml-sm" size="28" :disabled="!profileInput || switching" @meClick="setProfile">
                        {{ profile ? 'Сменить' : 'Задать' }}
                    </DivBtn>
                </div>
                <div v-if="profiles.length" class="row items-center q-mt-sm no-wrap">
                    <span class="text-grey-7 q-mr-sm">Существующие:</span>
                    <a
                        v-for="p in profiles"
                        :key="p"
                        :href="`#/tile/settings?profile=${encodeURIComponent(p)}`"
                        class="tile-chip"
                        :class="{'tile-chip-cur': p === profile}"
                    >{{ p }}</a>
                </div>
                <div v-if="!profile" class="tile-block-note q-mt-sm">
                    Профиль не задан: оценки, отметки и настройки не сохраняются.
                </div>
            </div>

            <div class="tile-set-block">
                <div class="tile-block-head">Ленты на главной</div>
                <div class="tile-block-note">Отключённые ленты не показываются</div>
                <div
                    v-for="f in baseFeeds"
                    :key="f.id"
                    class="row items-center tile-set-row"
                >
                    <div class="q-ml-xs" :class="disabledFeeds.has(f.id) ? 'la la-square-o text-grey-4' : 'la la-square text-primary'" @click="toggleFeed(f.id)" />
                    <span class="q-ml-sm">{{ f.name }}</span>
                </div>
                <div class="tile-subhead q-mt-sm">Жанровые ленты</div>
                <div
                    class="row items-center tile-set-row"
                >
                    <div class="q-ml-xs" :class="disabledFeeds.has('genres') ? 'la la-square-o text-grey-4' : 'la la-square text-primary'" @click="toggleFeed('genres')" />
                    <span class="q-ml-sm">Все жанровые ленты</span>
                </div>
                <template v-for="s in genreSections" :key="`set-${s.value}`">
                    <div class="row items-center tile-set-row tile-set-row-sub">
                        <div class="q-ml-sm" :class="disabledFeeds.has(`genre-new:${s.value}`) ? 'la la-square-o text-grey-4' : 'la la-square text-primary'" @click="toggleFeed(`genre-new:${s.value}`)" />
                        <span class="q-ml-sm">{{ s.name }}: новые</span>
                    </div>
                    <div class="row items-center tile-set-row tile-set-row-sub">
                        <div class="q-ml-sm" :class="disabledFeeds.has(`genre-best:${s.value}`) ? 'la la-square-o text-grey-4' : 'la la-square text-primary'" @click="toggleFeed(`genre-best:${s.value}`)" />
                        <span class="q-ml-sm">{{ s.name }}: лучшие</span>
                    </div>
                </template>
            </div>

            <div class="tile-set-block">
                <div class="tile-block-head">Книги в лентах</div>
                <div class="tile-block-note">Скрытые книги не показываются в лентах на главной и в жанровых списках</div>
                <template v-if="data && profile">
                    <div class="row items-center tile-set-row" @click="toggleHide('read')">
                        <div class="q-ml-xs" :class="data.hideRead ? 'la la-square text-primary' : 'la la-square-o text-grey-4'" />
                        <span class="q-ml-sm">Скрывать прочитанные</span>
                    </div>
                    <div class="row items-center tile-set-row" @click="toggleHide('rated')">
                        <div class="q-ml-xs" :class="data.hideRated ? 'la la-square text-primary' : 'la la-square-o text-grey-4'" />
                        <span class="q-ml-sm">Скрывать оценённые</span>
                    </div>
                </template>
                <div v-else class="tile-block-note q-mt-sm">
                    Задайте профиль, чтобы настроить скрытие
                </div>
            </div>

            <div class="tile-set-block">
                <div class="tile-block-head">Мои списки</div>
                <template v-if="data && profile">
                    <a class="row items-center tile-set-row tile-list-link" href="#/tile/read">
                        <i class="la la-check-circle q-ml-xs text-grey-6" />
                        <span class="q-ml-sm">Прочитанные ({{ readCount }})</span>
                    </a>
                    <a class="row items-center tile-set-row tile-list-link" href="#/tile/rated">
                        <i class="la la-star q-ml-xs text-grey-6" />
                        <span class="q-ml-sm">Оценённые ({{ ratedCount }})</span>
                    </a>
                </template>
                <div v-else class="tile-block-note q-mt-sm">
                    Задайте профиль, чтобы вести списки
                </div>
            </div>

            <div class="tile-set-block">
                <div class="tile-block-head">Игнорируемые</div>
                <div class="tile-block-note">Исключаются из лент, поиском найти можно</div>
                <template v-if="data && profile">
                    <div v-if="data.ignored.authors.length" class="tile-subhead q-mt-sm">Авторы</div>
                    <div v-for="a in data.ignored.authors" :key="`ig-a-${a.id}`" class="row items-center tile-set-row">
                        <span class="q-ml-xs la la-user text-grey-6" />
                        <span class="q-ml-sm">{{ a.name }}</span>
                        <div class="q-ml-md la la-times text-negative" @click="removeIgnore('author', String(a.id))" />
                    </div>
                    <div v-if="data.ignored.series.length" class="tile-subhead q-mt-sm">Серии</div>
                    <div v-for="s in data.ignored.series" :key="`ig-s-${s.name}`" class="row items-center tile-set-row">
                        <span class="q-ml-xs la la-layer-group text-grey-6" />
                        <span class="q-ml-sm">{{ s.name }}</span>
                        <div class="q-ml-md la la-times text-negative" @click="removeIgnore('series', s.name)" />
                    </div>
                    <div v-if="data.ignored.books.length" class="tile-subhead q-mt-sm">Книги</div>
                    <div v-for="b in data.ignored.books" :key="`ig-b-${b.uid}`" class="row items-center tile-set-row">
                        <span class="q-ml-xs la la-book text-grey-6" />
                        <span class="q-ml-sm">{{ b.title || b.uid }}<span v-if="b.author" class="text-grey-7"> — {{ b.author }}</span></span>
                        <div class="q-ml-md la la-times text-negative" @click="removeIgnore('book', b.uid)" />
                    </div>
                    <div v-if="!data.ignored.authors.length && !data.ignored.series.length && !data.ignored.books.length" class="tile-block-note q-mt-sm">
                        Ничего не игнорируется
                    </div>
                </template>
                <div v-else class="tile-block-note q-mt-sm">
                    Задайте профиль, чтобы использовать игнор
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import LoadingMessage from '../Search/LoadingMessage/LoadingMessage.vue';
import DivBtn from '../share/DivBtn.vue';

const componentOptions = {
    components: {
        LoadingMessage,
        DivBtn,
    },
    watch: {
        //переключение профиля чипом меняет только query — перечитываем
        $route() {
            this.load();
        },
    },
};
class TileSettings {
    _options = componentOptions;

    loadingMessage = '';
    error = '';
    switching = false;
    profileInput = '';
    profiles = [];
    data = null;
    genreSections = [];

    get profile() {
        return (this.$store.state.settings.tileProfile || '');
    }

    get disabledFeeds() {
        //id отключённых лент
        return new Set((this.data && this.data.disabledFeeds) || []);
    }

    get readCount() {
        return (this.data ? Object.keys(this.data.read || {}).length : 0);
    }

    get ratedCount() {
        return (this.data ? Object.keys(this.data.ratings || {}).length : 0);
    }

    baseFeeds = [
        {id: 'new', name: 'Новые книги'},
        {id: 'top', name: 'Лучшие книги'},
        {id: 'seriesNew', name: 'Серии: новые'},
        {id: 'seriesTop', name: 'Серии: лучшие'},
        {id: 'years', name: 'По годам'},
        {id: 'authors', name: 'Авторы'},
    ];

    created() {
        this.api = this.$root.api;
    }

    mounted() {
        this.profileInput = this.profile;
        this.load();
    }

    goHome() {
        this.$router.push('/tile');
    }

    async load() {
        this.error = '';
        this.data = null;
        this.loadingMessage = 'Загрузка...';
        try {
            const q = (this.$route.query.profile || '');
            if (q && q !== this.profile)
                this.commitProfile(q);

            await this.loadProfiles();
            await this.loadGenreTree();
            if (this.profile)
                await this.loadData();
        } catch (e) {
            this.error = e.message;
        } finally {
            this.loadingMessage = '';
        }
    }

    async loadProfiles() {
        try {
            const res = await this.api.listUserProfiles();
            this.profiles = (res.profiles || []);
        } catch (e) {
            //не критично
        }
    }

    async loadGenreTree() {
        if (this.genreSections.length)
            return;

        try {
            const tree = await this.api.getGenreTree();
            this.genreSections = tree.genreTree.map((s) => ({
                name: s.name,
                value: s.value.map((g) => g.value).join(','),
            }));
        } catch (e) {
            //не критично
        }
    }

    async loadData() {
        if (!this.profile) {
            this.data = null;
            return;
        }

        try {
            const res = await this.api.getUserData(this.profile);
            this.data = (res.data || null);
        } catch (e) {
            //битый/пустой профиль не критичен
        }
    }

    commitProfile(name) {
        name = (name || '').trim();
        if (!name || !/^[A-Za-z0-9._-]{1,32}$/.test(name) || !/[A-Za-z0-9]/.test(name))
            throw new Error('недопустимое имя профиля');

        this.$store.commit('setSettings', {tileProfile: name});
        this.profileInput = name;
    }

    async setProfile() {
        this.switching = true;
        try {
            this.commitProfile(this.profileInput);
            await this.loadData();
            await this.loadProfiles();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        } finally {
            this.switching = false;
        }
    }

    async toggleFeed(feedId) {
        if (!this.profile) {
            this.$root.stdDialog.alert('Сначала задайте профиль', 'Настройки');
            return;
        }

        try {
            await this.api.toggleFeed(this.profile, feedId);
            await this.loadData();
            await this.loadProfiles();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async toggleHide(kind) {
        if (!this.profile) {
            this.$root.stdDialog.alert('Сначала задайте профиль', 'Настройки');
            return;
        }

        try {
            if (kind === 'rated')
                await this.api.toggleHideRated(this.profile);
            else
                await this.api.toggleHideRead(this.profile);
            await this.loadData();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }

    async removeIgnore(kind, key) {
        if (!this.profile)
            return;

        try {
            await this.api.removeIgnore(this.profile, kind, key);
            await this.loadData();
            await this.loadProfiles();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'Ошибка');
        }
    }
}

export default vueComponent(TileSettings);
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

.tile-settings {
    padding: 12px 16px;
}

.tile-set-block {
    background: #ffffff;
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 12px;
}

.tile-set-input {
    flex: 0 1 300px;
    height: 30px;
    padding: 0 10px;
    border: 1px solid #cccccc;
    border-radius: 4px;
    font-size: 14px;
}

.tile-chip {
    display: inline-block;
    margin-right: 6px;
    padding: 2px 10px;
    background: #e3f2fd;
    border-radius: 10px;
    color: #1976d2;
    font-size: 12px;
    text-decoration: none;
}

a.tile-chip:hover {
    text-decoration: underline;
}

.tile-chip-cur {
    background: #1976d2;
    color: #ffffff;
}

.tile-set-row {
    line-height: 22px;
    cursor: pointer;
}

.tile-list-link {
    text-decoration: none;
}

a.tile-list-link:hover {
    background: #f0f7ff;
    border-radius: 4px;
}

.tile-set-row-sub {
    padding-left: 12px;
}

.tile-block-head {
    font-size: 16px;
    font-weight: bold;
    color: #333333;
}

.tile-block-note {
    font-size: 12px;
    color: #888888;
    margin-top: 4px;
}

.tile-subhead {
    font-size: 13px;
    font-weight: bold;
    color: #666666;
}
</style>
