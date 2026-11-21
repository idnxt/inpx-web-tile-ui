import { createRouter, createWebHashHistory } from 'vue-router';
import _ from 'lodash';

const Search = () => import('./components/Search/Search.vue');
const TileHome = () => import('./components/Tile/TileHome.vue');
const TileSection = () => import('./components/Tile/TileSection.vue');
const TileBook = () => import('./components/Tile/TileBook.vue');
const TileSearch = () => import('./components/Tile/TileSearch.vue');
const TileSettings = () => import('./components/Tile/TileSettings.vue');
const TileReader = () => import('./components/Tile/TileReader.vue');
const TileUserList = () => import('./components/Tile/TileUserList.vue');

const myRoutes = [
    ['/', Search],
    ['/author', Search],
    ['/series', Search],
    ['/title', Search],
    ['/favorites', Search],
    ['/extended', Search],
    ['/tile', TileHome],
    ['/tile/search', TileSearch],
    ['/tile/settings', TileSettings],
    ['/tile/read', TileUserList],
    ['/tile/rated', TileUserList],
    ['/tile/section/:type/:value', TileSection],
    ['/tile/book/:uid', TileBook],
    ['/tile/reader/:uid', TileReader],
    ['/:pathMatch(.*)*', null, null, '/'],
];

let routes = {};

for (let route of myRoutes) {
    const [path, component, name, redirect] = route;
    let cleanRoute = _.pickBy({path, component, name, redirect}, _.identity);
    
    let parts = cleanRoute.path.split('~');
    let f = routes;
    for (let part of parts) {
        const curRoute = _.assign({}, cleanRoute, { path: part });

        if (!f.children)
            f.children = [];
        let r = f.children;

        f = _.find(r, {path: part});
        if (!f) {
            r.push(curRoute);
            f = curRoute;
        }
    }
}
routes = routes.children;

export default createRouter({
    history: createWebHashHistory(),
    routes
});
