"use strict";

var exec = require("cordova/exec");
module.exports = {
    select: function (success, failure) { exec(success, failure, "SVVideoPicker", "select", []); }
};
