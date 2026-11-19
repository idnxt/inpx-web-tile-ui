<template>
    <div class="tile-searchbar">
        <div class="row items-center no-wrap">
            <input
                v-model="searchQuery"
                class="tile-search-input"
                type="text"
                maxlength="200"
                placeholder="Поиск: автор, серия, название, год, жанр..."
                @keyup.enter="goSearch"
                @keyup.esc="hideSuggest"
                @blur="onSearchBlur"
            />
            <div v-if="suggestBusy" class="q-ml-sm">
                <q-spinner size="18px" color="primary" />
            </div>
            <div class="q-ml-sm">
                <DivBtn size="28" icon="la la-search" :disabled="!canSearch" @meClick="goSearch">поиск</DivBtn>
            </div>
        </div>
        <div v-if="showSuggest && suggestions.length" class="tile-suggest">
            <div v-for="b in suggestions" :key="b._uid" class="tile-suggest-item" @mousedown.prevent="openBook(b)">
                {{ suggestLine(b) }}
            </div>
        </div>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import DivBtn from '../share/DivBtn.vue';

const componentOptions = {
    components: {
        DivBtn,
    },
    watch: {
        searchQuery() {
            this.onSearchInput();
        },
    },
};
class TileSearchBar {
    _options = componentOptions;

    searchQuery = '';
    suggestions = [];
    showSuggest = false;
    suggestBusy = false;
    suggestFlag = 0;
    suggestTimer = null;

    created() {
        this.api = this.$root.api;
    }

    get canSearch() {
        return !!this.searchQuery.trim();
    }

    onSearchInput() {
        if (this.suggestTimer) {
            clearTimeout(this.suggestTimer);
            this.suggestTimer = null;
        }
        const q = this.searchQuery.trim();
        if (q.length < 2) {
            this.suggestions = [];
            this.showSuggest = false;
            this.suggestBusy = false;
            return;
        }
        this.suggestTimer = setTimeout(() => this.loadSuggestions(q), 300);
    }

    async loadSuggestions(q) {
        const flag = ++this.suggestFlag;
        this.suggestBusy = true;
        try {
            const result = await this.api.bookSearchAny(q, 10, 0);
            if (flag !== this.suggestFlag)
                return;
            this.suggestions = (result.found || []);
            this.showSuggest = true;
        } catch (e) {
            if (flag === this.suggestFlag) {
                this.suggestions = [];
                this.showSuggest = false;
            }
        } finally {
            if (flag === this.suggestFlag)
                this.suggestBusy = false;
        }
    }

    suggestLine(b) {
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
        this.hideSuggest();
        this.$router.push(`/tile/book/${encodeURIComponent(b._uid)}`);
    }

    hideSuggest() {
        this.showSuggest = false;
    }

    onSearchBlur() {
        setTimeout(() => this.hideSuggest(), 200);
    }

    goSearch() {
        const q = this.searchQuery.trim();
        if (!q)
            return;
        this.hideSuggest();
        this.$router.push({path: '/tile/search', query: {q}});
    }

    unmounted() {
        if (this.suggestTimer) {
            clearTimeout(this.suggestTimer);
            this.suggestTimer = null;
        }
    }
}

export default vueComponent(TileSearchBar);
</script>

<style scoped>
.tile-searchbar {
    position: relative;
}

.tile-search-input {
    flex: 1 1 auto;
    min-width: 0;
    height: 28px;
    padding: 0 10px;
    font-size: 14px;
    border: 1px solid #b2dfdb;
    border-radius: 4px;
    background: #ffffff;
    color: #333333;
    outline: none;
}

.tile-search-input:focus {
    border-color: #1976d2;
}

.tile-suggest {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    margin-top: 2px;
    z-index: 20;
    background: #ffffff;
    border: 1px solid #b2dfdb;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    max-height: 320px;
    overflow: auto;
}

.tile-suggest-item {
    padding: 7px 10px;
    font-size: 13px;
    color: #333333;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
}

.tile-suggest-item:hover {
    background: #e0f2f1;
}
</style>
