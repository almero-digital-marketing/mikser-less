'use strict'

var Promise = require('bluebird');
var lessMiddleware = require('less-middleware');
var fs = require("fs-extra-promise");
var cluster = require('cluster');
var path = require('path');
var minimatch = require("minimatch");
var glob = require('glob-promise');
var express = require('express');

module.exports = function (mikser) {

	let debug = mikser.debug('less');
	let lessPatternt = '**/*.less';
	let cssPatternt = '**/*.css';
	let lessFolder = path.join(mikser.config.runtimeFolder, 'less');

	if (cluster.isMaster) {
		mikser.on('mikser.server.listen', (app) => {
			var sourceMap = {sourceMapFileInline: true};
			if (mikser.config.less && mikser.config.less.sourceMap == false) {
				sourceMap = undefined;
			}
			for(let replica of mikser.config.shared) {
				app.use('/' + replica, lessMiddleware(mikser.config.filesFolder, {
					dest: path.join(lessFolder, replica),
					render: {
						sourceMap: sourceMap
					}
				}));
			}

			if (fs.existsSync(mikser.config.replicateFolder)) {
				app.use(lessMiddleware(mikser.config.replicateFolder, {
					dest: lessFolder,
					render: {
						sourceMap: sourceMap
					}
				}));
			}

			app.use(express.static(lessFolder));
		});

		return {
			compile: function(file) {
				if (mikser.config.browser && file && minimatch(file, lessPatternt)) {
					glob(cssPatternt, { cwd: lessFolder }).then((files) => {
						return Promise.map(files, (file) => {
							mikser.emit('mikser.watcher.outputAction', 'compile', file);
						});
					});
					return Promise.resolve(true);
				}
				return Promise.resolve(false);
			}
		}
	}

}