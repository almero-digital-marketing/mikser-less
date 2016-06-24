'use strict'

var Promise = require('bluebird');
var lessMiddleware = require('less-middleware');
var fs = require("fs-extra-promise");
var cluster = require('cluster');
var path = require('path');
var minimatch = require("minimatch");
var glob = require('glob-promise');
var express = require('express');
var less = require('less');
var extend = require('node.extend');

module.exports = function (mikser, context) {
	let debug = mikser.debug('less');
	let lessPattern = '**/*.less';
	let cssPattern = '**/*.css';
	let lessFolder = path.join(mikser.config.runtimeFolder, 'less');

	if (context) {
		context.less = function(source, destination, options) {
			if (destination && typeof destination != 'string') {
				options = destination;
				destination = undefined;
			}
			let lessInfo = {
				source: mikser.utils.findSource(source),
				options: options
			}
			if (!options) {
				lessInfo.options = {
					fileName: lessInfo.source,
					paths: [path.dirname(lessInfo.source)]
				}
			}
			if (destination) {
				if (destination.indexOf(mikser.options.workingFolder) !== 0) {
					if (context) {
						lessInfo.destination = mikser.utils.resolveDestination(destination, context.entity.destination);
					} else {
						lessInfo.destination = path.join(mikser.options.workingFolder, destination);
					}
				}
				else {
					lessInfo.destination = destination;
				}
			} else {
				lessInfo.destination = mikser.utils.predictDestination(source).replace('.less', '.css');
				lessInfo.destination = mikser.utils.resolveDestination(lessInfo.destination, context.entity.destination);
			}


			context.process(() => {
				let action;
				if (cluster.isMaster) {
					action = mikser.plugins.less.process(lessInfo);
				} else {
					action = mikser.broker.call('mikser.plugins.less.process', lessInfo);
				}
				return action.catch((err) => {
					mikser.diagnostics.log(context, 'error', 'Error processing:', lessInfo.destination, err);
				});
			});
			return mikser.manager.getUrl(lessInfo.destination);
		}
	} else {

		if (mikser.config.compile) mikser.config.compile.push('less');
		else mikser.config.compile = ['less'];

		if (cluster.isMaster) {

			function isNewer(source, destination) {
				let lessOutput = path.join(lessFolder, destination.replace(mikser.options.workingFolder,'').replace('.css','.json'));
				if (fs.existsSync(lessOutput)) {
					let lessInfo = fs.readJsonSync(lessOutput);
					return mikser.utils.isNewer(source, destination) || mikser.utils.isNewer(lessInfo.imports, destination);
				}
				return true;
			}

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
					if (mikser.config.browser && file && minimatch(file, lessPattern)) {
						return glob('**/*.json', { cwd: lessFolder }).then((outputFiles) => {
							if (outputFiles.length) {
								let recompile = [];
								return Promise.map(outputFiles, (outputFile) => {
									let lessOutput = path.join(lessFolder, outputFile);
									return fs.readJsonAsync(lessOutput).then((lessInfo) => {
										if (lessInfo.source == file || lessInfo.imports.indexOf(file) != -1) {
											recompile.push(lessInfo);
											//console.log(output.info.destination);
											mikser.emit('mikser.watcher.outputAction', 'compile', lessInfo.destination);
										}
									});
								}).delay(3000).then(() => {
									console.log('Less compile:', recompile.length);
									return mikser.watcher.stop('reload').then(() => {
										return Promise.map(recompile, mikser.plugins.less.process);
									});
								}).then(mikser.watcher.start).then(() => {
									return Promise.resolve(recompile.length > 0);	
								});
							} else {
								return glob(cssPattern, { cwd: lessFolder }).then((files) => {
									return Promise.map(files, (cssFile) => {
										mikser.emit('mikser.watcher.outputAction', 'compile', cssFile);
									});
								});								
							}
						});
					}
					return Promise.resolve(false);
				},
				process: function(lessInfo) {
					if (isNewer(lessInfo.source, lessInfo.destination)) {
						let capturedOptions = extend(true, {}, lessInfo.options);
						return fs.readFileAsync(lessInfo.source, { encoding: 'utf8' })
							.then((input) => {
								return less.render(input, lessInfo.options);
							})
							.then((output) => {
								debug('Processed:', lessInfo.source);
								let lessOutput = path.join(lessFolder, lessInfo.destination.replace(mikser.options.workingFolder,'').replace('.css','.json'));
								return Promise.join(
									fs.outputFileAsync(lessInfo.destination, output.css),
									fs.outputJson(lessOutput, {
										source: lessInfo.source,
										destination: lessInfo.destination,
										imports: output.imports,
										options: capturedOptions
									})
								);
							});
					}
					return Promise.resolve();
				}
			}
		}
	}

}