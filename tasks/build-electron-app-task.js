/*
 * grunt-electron-app-builder
 * https://github.com/vtherli/grunt-electron-app-builder
 *
 * Copyright (c) 2015 Vasumithra Therli
 *
 * Licensed under the Apache 2.0 license.
 */

var path = require('path');
var fs = require('fs');
var request = require('request');
var async = require('async');
var wrench = require('wrench');
var decompressZip = require('decompress-zip');
var progress = require('progress');
var _ = require('lodash');
var glob = require('glob');

module.exports = function(grunt) {

    grunt.registerTask(
        'build-electron-app',
        'Package the app as an electron application',
        function() {
            var done = this.async();
            var options = this.options({
                electron_version: null,
                build_dir: "build",
                cache_dir: "cache",
                app_dir: "app",
                platforms: [process.platform]
            });

            options.platforms.forEach(function(platform){
                var supportedPlatforms = ['darwin','win32','linux','linux32','linux64'];
                if (supportedPlatforms.indexOf(platform) == -1) {
                    grunt.log.warn('Unsupported platform: [' + platform + ']');
                }
            });

            if (options.platforms.indexOf('linux') >= 0 && options.platforms.indexOf('linux32') >= 0) {
                grunt.log.warn("linux32 and linux are equivalent, but you're trying to build both. Removed 'linux' from the target platforms.")
                options.platforms.splice(options.platforms.indexOf('linux'), 1);
            }

            if ((process.platform == 'win32') && options.platforms.indexOf('darwin') != -1) {
                grunt.log.warn("Due to symlinks in the electron zip, darwin builds are not supported on Windows and will be skipped.");
                options.platforms.splice(options.platforms.indexOf('darwin'), 1);
            }

            async.waterfall([
                function(callback) {
                    getLatestTagIfNeeded(options, callback);
                },
                verifyTagAndGetReleaseInfo,
                downloadReleases,
                extractReleases,
                addAppSources
            ], function(err) { if (err) throw err; done(); }
        );
    });


    function addArchitectureToPlatform(platform)
    {
        if (platform === 'darwin')
        {
            platform = 'darwin-x64';
        }
        else if (platform === 'win32' || platform === 'linux')
        {
            platform = platform + '-ia32';
        }
        else if (platform === 'linux32') {
            platform = 'linux-ia32';
        }
        else if (platform === 'linux64') {
            platform = 'linux-x64';
        }
        return platform;
    }

    function getLatestTagIfNeeded(options, callback)
    {
        if (options.electron_version)
            callback(null, options, null);
        else
        {
            request({
                    url: 'https://api.github.com/repos/atom/electron/releases',
                    json: true,
                    headers: {
                        'User-Agent': "grunt-electron-app-builder"
                    }
                }
                , function(error, response, body) {
                    if (error)
                        callback(error);
                    if (response.statusCode == 403)
                        callback(new Error("github API unexpected response in getLatestTagIfNeeded() with HTTP response code of " + response.statusCode + '. Probably hit the throttle limit.'));
                    if (response.statusCode != 200)
                        callback(new Error("github API unexpected response in getLatestTagIfNeeded() with HTTP response code of " + response.statusCode));

                    var releaseInfo = _.find(body, {'prerelease' : false });
                    options.electron_version = releaseInfo.tag_name;
                    callback(null, options, body);
                }
            );
        }
    }

    function verifyTagAndGetReleaseInfo(options, responseBody, callback)
    {
        if (responseBody)
        {
            var releaseInfo = _.find(responseBody, {'tag_name' : options.electron_version });
            if (!releaseInfo)
            {
                callback(new Error("Could not find a release with tag " + options.electron_version));
            }
            callback(null, options, releaseInfo);
        }
        else
        {
            request({
                    url: 'https://api.github.com/repos/atom/electron/releases',
                    json: true,
                    headers: {
                        'User-Agent': "grunt-electron-app-builder"
                    }
                }
                , function(error, response, body) {
                    if (error)
                        callback(error);
                    if (response.statusCode == 403)
                        callback(new Error("github API unexpected response in verifyTag() with HTTP response code of " + response.statusCode + '. Probably hit the throttle limit.'));
                    if (response.statusCode != 200)
                        callback(new Error("github API unexpected response in verifyTag() with HTTP response code of " + response.statusCode));

                    var releaseInfo = _.find(body, {'tag_name' : options.electron_version });
                    if (!releaseInfo)
                    {
                        callback(new Error("Could not find a release with tag " + options.electron_version));
                    }
                    callback(null, options, releaseInfo);
                }
            );
        }
    }

    function downloadReleases(options, releaseInfo, callback)
    {
        grunt.log.subhead("Downloading releases...")
        options.platforms.forEach(function(platform) {
            wrench.mkdirSyncRecursive(options.cache_dir);
        });
        async.eachSeries(options.platforms,
            function(platform, localcallback) {
                downloadIndividualRelease(options, releaseInfo, platform, localcallback);
            }, function(err) { callback(err,options); }
        );
    }

    function downloadIndividualRelease(options, releaseInfo, platform, callback)
    {
        var assetName = "electron-" + options.electron_version + "-" + addArchitectureToPlatform(platform) + ".zip";
        var foundAsset = _.find(releaseInfo.assets, {'name' : assetName });
        if (!foundAsset) {
            grunt.log.writeln("Asset not found: " + assetName);
            grunt.log.writeln("Available assets:");

            releaseInfo.assets.forEach(function (asset) {
                grunt.log.writeln("\t" + asset.name);
            });

            throw new Error("Failed to find asset: " + assetName);
        }

        var assetUrl = foundAsset.url;
        var assetSize = foundAsset.size;
        var saveLocation = path.join(options.cache_dir,assetName);

        if (fs.existsSync(saveLocation))
        {
            var stats = fs.statSync(saveLocation);
            if (stats.isFile() && (stats.size == assetSize))
            {
                grunt.log.ok(" Found cached download of " + assetName);
                callback();
                return;
            }
        }
        grunt.log.writeln(" Downloading electron for " + platform);
        var bar;
        request({
                url: assetUrl,
                headers: {
                    'User-Agent': "grunt-electron-app-builder",
                    "Accept" : "application/octet-stream"
                }
            }).on('end', function() {
                    callback();
            }).on('response', function(response) {
                bar = new progress('  [:bar] :percent :etas', {
                    complete: '=',
                    incomplete: ' ',
                    width: 20,
                    total: parseInt(response.headers['content-length'])
                });
            }).on('data', function(chunk) {
                bar.tick(chunk.length);
            }).pipe(fs.createWriteStream(saveLocation));
    }

    function extractReleases(options, callback)
    {
        grunt.log.subhead("Extracting releases...")
        async.eachSeries(options.platforms,
            function(platform, localcallback) {
                grunt.log.ok("Extracting " + platform);
                wrench.rmdirSyncRecursive(path.join(options.build_dir, platform), true);
                wrench.mkdirSyncRecursive(path.join(options.build_dir, platform));
                var zipPath = path.join(options.cache_dir, "electron-" + options.electron_version + "-" + addArchitectureToPlatform(platform) + ".zip");
                var destPath = path.join(options.build_dir, platform);
                if (process.platform != 'win32' && platform == 'darwin')
                {
                    spawn = require('child_process').spawn;
                    zip = spawn('unzip',['-qq','-o', zipPath, '-d', destPath]);
                    zip.on('exit', function(code) {
                        localcallback(null);
                    });
                    zip.stdout.on('data', function(data) { });
                    zip.stderr.on('data', function(data) { });
                    zip.on('error', function(err){
                        grunt.log.error(err);
                        localcallback(err);
                    });
                }
                else
                {
                    var unzipper = new decompressZip(zipPath);
                    unzipper.on('error', function(err) {
                        grunt.log.error(err);
                        localcallback(err);
                    });
                    unzipper.on('extract', function(log){
                        localcallback();
                    });
                    unzipper.extract({
                        path: destPath
                    });
                }
            }, function(err) { callback(err,options); }
        );
    }

    //
    // Return if the requested platform contain 'platform' as a sub-string.
    //
    function isPlatformRequested(requestedPlatform, platform) {
        return requestedPlatform.indexOf(platform) != -1;
    }

    function addAppSources(options, callback)
    {
        grunt.log.subhead("Adding app to releases.")

        var appFiles = null;

        if (options.app_files && options.app_files.length) {
          var appFilesInclude = [];
          var appFilesExclude = [];
          appFiles = [];

          options.app_files.forEach(function(f) {
            if (f.substr(0,1) == '!') {
              appFilesExclude.push(f.substr(1));
            }
            else {
              appFilesInclude.push(f);
            }
          })

          appFilesInclude.forEach(function(f) {
            Array.prototype.push.apply(appFiles, glob.sync(f, {ignore: appFilesExclude}));
          });
        }

        options.platforms.forEach(function (requestedPlatform) {

            var buildOutputDir = path.join(options.build_dir, requestedPlatform);
            var appOutputDir;

            if (isPlatformRequested(requestedPlatform, "darwin")) {
                appOutputDir = path.join(buildOutputDir, "Electron.app", "Contents","Resources", "app");
            }
            else if (isPlatformRequested(requestedPlatform, "win32") ||
                     isPlatformRequested(requestedPlatform, "linux")) {

                appOutputDir = path.join(buildOutputDir, "resources", "app");
            }
            else {
                grunt.log.fail("Failed to copy app, platform not understood: " + requestedPlatform);
            }

            if (appOutputDir) {
              if (appFiles) {
                try {
                  if (fs.statSync(appOutputDir).isDirectory()) {
                    wrench.rmdirSyncRecursive(appOutputDir);
                  }
                } catch(e) { }

                fs.mkdirSync(appOutputDir);
                for (var i=0,l=appFiles.length; i<l; i++) {
                  var appFileDest = path.join(appOutputDir, appFiles[i])
                  var stats = fs.statSync(appFiles[i])
                  if (stats.isDirectory()) {
                    fs.mkdirSync(appFileDest)
                  }
                  else {
                    fs.writeFileSync(appFileDest, fs.readFileSync(appFiles[i]));
                    var appFileStat =  fs.lstatSync(appFiles[i]);
                    fs.chmodSync(appFileDest, appFileStat.mode);
                    fs.utimesSync(appFileDest, appFileStat.atime, appFileStat.mtime)
                  }
                }
              }
              else {
                wrench.copyDirSyncRecursive(options.app_dir, appOutputDir, {
                    forceDelete: true,
                    excludeHiddenUnix: true,
                    preserveFiles: false,
                    preserveTimestamps: true,
                    inflateSymlinks: true
                });
              }

              grunt.log.ok("Build for platform " + requestedPlatform + " located at " + buildOutputDir);
            }
        });

        callback();
    }
};
