const Favorites = require('../../server/core/Favorites');
const SevenZipHelper = require('../../server/core/SevenZipHelper');
const UserData = require('../../server/core/UserData');

function resetSingletons() {
    Favorites.instance = null;
    UserData.instance = null;
    SevenZipHelper._sevenZipCmd = undefined;
    SevenZipHelper._configuredPath = '';
}

module.exports = { resetSingletons };