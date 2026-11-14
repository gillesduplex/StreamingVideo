
(function () {
    const estServeurWeb = /^https?:$/.test(location.protocol) &&
        (location.pathname.startsWith("/app/") || location.port === "3001");

    window.APP_CONFIG = {
        API_BASE_URL: estServeurWeb
            ? location.origin + "/api"
            : "http://192.168.1.193:3001/api"
    };
})();
