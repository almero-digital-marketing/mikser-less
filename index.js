'use strict'

var Promise = require('bluebird');
var fs = require("fs-extra-promise");
var cluster = require('cluster');
var path = require('path');
var minimatch = require("minimatch");
var glob = require('glob-promise');
var express = require('express');
var less = require('less');
var extend = require('node.extend');
var _ = require('lodash');

module.exports = function (mikser, context) {
	let debug = mikser.debug('less');
	let lessPattern = '**/*.less';
	let cssPattern = '**/*.css';
	let lessFolder = path.join(mikser.config.runtimeFolder, 'less');

	if (context) {
		context.less = function(source, destination, options) {
			let sourceFile = mikser.utils.findSource(source);
			let defaultOptions = {
				fileName: sourceFile,
				paths: [path.dirname(sourceFile),path.join(mikser.options.workingFolder, 'node_modules')],
				sourceMap: {sourceMapFileInline: true}
			}
			if (destination && typeof destination != 'string') {
				options = destination;
				destination = undefined;
			}
			let lessInfo = {
				source: sourceFile,
				options: _.defaults(options, defaultOptions)
			}
			if (!options) {
				lessInfo.options = {
					fileName: sourceFile,
					paths: [path.dirname(lessInfo.source),path.join(mikser.options.workingFolder, 'node_modules')],
					sourceMap: {sourceMapFileInline: true}
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
				lessInfo.destination = mikser.utils.predictDestination(sourceFile).replace('.less', '.css');
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
			return mikser.utils.getUrl(lessInfo.destination);
		}
	} else {

		if (mikser.config.compile) mikser.config.compile.push('less');
		else mikser.config.compile = ['less'];

		if (cluster.isMaster) {

			function isNewer(source, destination) {
				let lessOutput = path.join(lessFolder, destination.replace(mikser.options.workingFolder,'').replace('.css','.json'));
				if (fs.existsSync(lessOutput)) {
					try {
						var lessInfo = fs.readJsonSync(lessOutput);
					} catch (err) {
						debug('Erorr processing', lessOutput, err);
						debug(fs.readFileSync(lessOutput, { encoding: 'utf8' }));
						return true;
					}
					return mikser.utils.isNewer(source, destination) || mikser.utils.isNewer(lessInfo.imports, destination);
				}
				return true;
			}

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
								}).then(() => {
									console.log('Less compile:', recompile.length);
									return Promise.map(recompile, mikser.plugins.less.process);
								}).then(() => {
									return Promise.resolve(recompile.length > 0);	
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