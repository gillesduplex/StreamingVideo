"use strict";

var exec = require("cordova/exec");
module.exports = {
    landscape: function (success, failure) { exec(success, failure, "SVScreenOrientation", "landscape", []); },
    restore: function (success, failure) { exec(success, failure, "SVScreenOrientation", "restore", []); }
};
