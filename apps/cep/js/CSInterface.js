/*
 * FontDeck CSInterface 精简版
 * 只封装本项目用到的 CEP 能力，避免引入 Adobe 完整库（3000+ 行）。
 * 依赖 CEP 注入的 window.__adobe_cep__。
 */
(function () {
    "use strict";

    function CSInterface() {}

    CSInterface.prototype.isAvailable = function () {
        return typeof window.__adobe_cep__ !== "undefined";
    };

    CSInterface.prototype.getHostEnvironment = function () {
        try {
            return JSON.parse(window.__adobe_cep__.getHostEnvironment());
        } catch (e) {
            return null;
        }
    };

    CSInterface.prototype.getExtensionId = function () {
        try {
            return window.__adobe_cep__.getExtensionId();
        } catch (e) {
            return null;
        }
    };

    CSInterface.prototype.getSystemPath = function (pathType) {
        try {
            return decodeURI(window.__adobe_cep__.getSystemPath(pathType));
        } catch (e) {
            return null;
        }
    };

    CSInterface.prototype.evalScript = function (script, callback) {
        var cb = typeof callback === "function" ? callback : function () {};
        if (!this.isAvailable()) {
            cb("EvalScript error: CEP runtime not available");
            return;
        }
        try {
            window.__adobe_cep__.evalScript(script, cb);
        } catch (e) {
            cb("EvalScript error: " + e.message);
        }
    };

    CSInterface.prototype.addEventListener = function (type, listener, obj) {
        if (!this.isAvailable()) return;
        window.__adobe_cep__.addEventListener(type, listener, obj);
    };

    CSInterface.prototype.dispatchEvent = function (event) {
        if (!this.isAvailable()) return;
        window.__adobe_cep__.dispatchEvent(event);
    };

    CSInterface.prototype.requestOpenExtension = function (id, params) {
        if (!this.isAvailable()) return;
        window.__adobe_cep__.requestOpenExtension(id, params);
    };

    /* 路径常量，够用即可 */
    CSInterface.prototype.Extension = {
        USER_DATA: "userData",
        COMMON_FILES: "commonFiles",
        MY_DOCUMENTS: "myDocuments",
        APPLICATION: "application",
        EXTENSION: "extension",
        HOST_APPLICATION: "hostApplication"
    };

    window.CSInterface = CSInterface;
})();
