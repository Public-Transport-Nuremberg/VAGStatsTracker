const { getWebtokenSave } = require("@lib/cache");
const crypto = require('crypto');

const matchesEnvironmentAdminToken = (token) => {
    const configuredToken = process.env.ADMIN_TOKEN;
    if (!configuredToken || !token) return false;
    const supplied = Buffer.from(String(token));
    const configured = Buffer.from(String(configuredToken));
    return supplied.length === configured.length && crypto.timingSafeEqual(supplied, configured);
};

/**
 * Will check if a Token is valid
 * @param {String} Token Token 
 * @param {String} browser Browser
 * @returns {Promise}
 */
const checkWebToken = function (Token, browser) {
    return new Promise(async (resolve, reject) => {
        try {
            if (matchesEnvironmentAdminToken(Token)) {
                return resolve({
                    State: true,
                    Data: {
                        user_id: 0,
                        username: 'env-admin',
                        permissions: ['*'],
                        user_group: 'admin',
                        browser: '*',
                        permanent: true,
                    },
                });
            }
            const webtokenRespone = await getWebtokenSave(Token)
            if (!webtokenRespone) return resolve({ State: false, DidExist: false })
            const DBTime = webtokenRespone.expiresAt
                ? new Date(webtokenRespone.expiresAt).getTime()
                : new Date(webtokenRespone.time).getTime() + parseInt(process.env.WebTokenDurationH, 10) * 60 * 60 * 1000
            //Check if Token isn´t too old
            if (DBTime < new Date().getTime()) return resolve({ State: false, DidExist: true })
            //Check if Browser is the same
            if (webtokenRespone.browser !== '*' && browser !== webtokenRespone.browser) return resolve({ State: false, DidExist: true })
            resolve({ State: true, Data: webtokenRespone })
        } catch (error) {
            reject(error)
        }
    })
}

module.exports = {
    checkWebToken
};
