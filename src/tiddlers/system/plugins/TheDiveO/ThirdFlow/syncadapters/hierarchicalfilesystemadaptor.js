/*\
title: $:/plugins/TheDiveO/ThirdFlow/syncadapters/hierarchicalfilesystemadaptor.js
type: application/javascript
module-type: syncadaptor

A sync adaptor module for synchronising with the local filesystem via node.js APIs
...in contrast to filesystemadaptor.js this variant understands forward slashes "/"
in tiddler titles and stores tiddlers appropriately in the file system by mapping
the hierarchy in the title to a (sub) directory structure.

In addition, this sync adaptor understands the concept of system tiddlers (starting
their titles with "$:/") and stores them inside a "special" system branch.

Moreover, this sync adaptor also understands the concept of draft tiddlers (based
on the presence of the "draft.of" field) and stores all draft tiddlers in a flat
single "drafts" folder. The makes cleanup and (git) repository syncing easier to do.

In order to realize good modularity and to allow this sync adaptor to be enhanced
at any time later in an easy manner, it supports so-called folder policy modules.
These are module tiddlers with a module-type of "folderpolicy". Folder policy modules
need to export a method named "folderpolicy". In addition, folder policy modules
can be assigned a priority value. Normally, the priority of a folder policy should
be between 199 and 1, inclusively. Priority 200 is currently used for the draft
tiddler policy. Priority 0 is assigned to the default policy.

The code for this sync adaptor comes from filesystemadaptor.js and has been enhanced
to support hierarchical tiddler storage as well as folder policies.
\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

// Get a reference to the file system
var fs = !$tw.browser ? require("fs") : null,
	path = !$tw.browser ? require("path") : null;

function HierarchicalFileSystemAdaptor(options) {
	var self = this;
	this.wiki = options.wiki;
	this.logger = new $tw.utils.Logger("HierarchicalFileSystem");
	// Create the <wiki>/tiddlers folder if it doesn't exist
	$tw.utils.createDirectory($tw.boot.wikiTiddlersPath);
	
	this.config = {
		disabled: false
	};
	
	// retrieve all folder usher modules and sort them according
	// to their priority, with higher priority values towards
	// the start of our usher modules list.
	var fpModules = [];
	$tw.modules.forEachModuleOfType("folderpolicy", function(title, exports) {
		fpModules.push({
			title: title, // just for logging
			priority: options.wiki.getTiddler(title).fields.priority || 100,
			config: exports.config,
			policy: exports.folderpolicy || function() { return false; }
		});
	});
	fpModules.sort(function(policyA, policyB) {
		return policyB.priority - policyA.priority;
	});
	this.logger.log(fpModules.length + " folder policies");
	this.policyModules = fpModules;
	
	if($tw.boot.wikiInfo.config["disable-hfs"]) {
		this.config.disabled = true;
		this.logger.log("plugin disabled; no saving and deleting");
	}
}

HierarchicalFileSystemAdaptor.prototype.getTiddlerInfo = function(tiddler) {
	return {};
};

// Nota Bene: this needs to mirror the file extension information as established
// in function $tw.boot.startup (boot.js). Otherwise, the sync adaptor will use
// another encoding than expected by the boot process.
$tw.config.typeInfo = {
	"text/vnd.tiddlywiki": {
		fileType: "application/x-tiddler",
		extension: ".tid"
	},
	"image/jpeg" : {
		hasMetaFile: true,
		encoding: "base64"
	},
	"image/png" : {
		hasMetaFile: true,
		encoding: "base64"
	}
};

$tw.config.typeTemplates = {
	"application/x-tiddler": "$:/core/templates/tid-tiddler"
};

HierarchicalFileSystemAdaptor.prototype.getTiddlerFileInfo = function(tiddler,callback) {
	// See if we've already got information about this file
	var self = this,
		title = tiddler.fields.title,
		fileInfo = $tw.boot.files[title],
		draftOf = tiddler.fields["draft.of"];
	// Get information about how to save tiddlers of this type
	var type = tiddler.fields.type || "text/vnd.tiddlywiki",
		typeInfo = $tw.config.typeInfo[type];
	if(!typeInfo) {
		typeInfo = $tw.config.typeInfo["text/vnd.tiddlywiki"];
	}
	var extension = typeInfo.extension || "";
	if(!fileInfo) {
		// If not, we'll need to generate it
		var paf = self.generateTiddlerPathAndFilename(tiddler, title, draftOf);
		var folder = $tw.boot.wikiTiddlersPath+path.sep+paf.subfolder;
		$tw.utils.createDirectory(folder);
		// Start by getting a list of the existing files in the directory
		fs.readdir(folder,function(err,files) {
			if(err) {
				return callback(err);
			}
			// Assemble the new fileInfo
			fileInfo = {};
			
			fileInfo.filepath = folder + path.sep + self.generateUniqueTiddlerFilename(paf.name,draftOf,extension,files);
			fileInfo.type = typeInfo.fileType || tiddler.fields.type;
			fileInfo.hasMetaFile = typeInfo.hasMetaFile;
			// Save the newly created fileInfo
			$tw.boot.files[title] = fileInfo;
			// Pass it to the callback
			callback(null,fileInfo);
		});
	} else {
		// Otherwise just invoke the callback
		callback(null,fileInfo);
	}
};

HierarchicalFileSystemAdaptor.prototype.subfoldersFromTitle = function(title) {
	var lastSlash = title.lastIndexOf("/");
	if (lastSlash<=0) {
		return "";
	} else {
		return title.substr(0,lastSlash+1);
	}
};

HierarchicalFileSystemAdaptor.prototype.leafFromTitle = function(title) {
	var lastSlash = title.lastIndexOf("/");
	if (lastSlash<0) {
		return title;
	} else {
		return title.substr(lastSlash+1);
	}
};

HierarchicalFileSystemAdaptor.prototype.generateTiddlerPathAndFilename = function(tiddler, title, draftOf) {
	// set up the policy method options such that if in a rare circumstance no policy
	// should fire, then we fall back to plain old flat storage in the main wiki folder.
	var options = {
		tiddler: tiddler, // in: tiddler object we're trying a policy to find for
		draft: !!draftOf, // in: is this a draft tiddler?
		subfolder: "", // out: folder into which to place the tiddler file
		name: title // out: name of tiddler file
	};
	
	// run through our ordered list of folder policies and wait for one of them
	// to return true because its folder policy should be applied.
	for (var i=0; i<this.policyModules.length; ++i) {
		if (this.policyModules[i].policy.call(this, title, options)) {
			break;
		}
	}
	
	// Sanitize the filename as well as the subfolder(s) name(s)...
	// This more or less comes down to removing those characters that are illegal in
	// Windows file names. Oh, and we also hammer out any hierarchy slashes inside
	// the filename, thereby flattening it.
	options.name = options.name.replace(/\<|\>|\:|\"|\/|\\|\||\?|\*|\^/g,"_");
	// For the subfolder path we are converting hierarchy slashes into the proper
	// platform-specific separators.
	options.subfolder = options.subfolder.replace(/\<|\>|\:|\"|\\|\||\?|\*|\^/g,"_").replace(/\//g, path.sep);
	
	this.logger.log("subfolder: " + options.subfolder);
	this.logger.log("name: " + options.name);
	return options;
};

/*
Given a tiddler title and an array of existing filenames, generate a new legal filename for the title, case insensitively avoiding the array of existing filenames
*/
HierarchicalFileSystemAdaptor.prototype.generateUniqueTiddlerFilename = function(baseFilename,draftOf,extension,existingFilenames) {
	// Truncate the filename if it is too long
	if(baseFilename.length > 200) {
		baseFilename = baseFilename.substr(0,200);
	}
	// Start with the base filename plus the extension
	var filename = baseFilename + extension,
		count = 1;
	// Add a discriminator if we're clashing with an existing filename
	while(existingFilenames.indexOf(filename) !== -1) {
		filename = baseFilename + " " + (count++) + extension;
	}
	return filename;
};

/*
Save a tiddler and invoke the callback with (err,adaptorInfo,revision)
*/
HierarchicalFileSystemAdaptor.prototype.saveTiddler = function(tiddler,callback) {
	if(this.config.disabled) {
		this.logger.log("saving disabled");
		return callback(null, {}, 0);
	}
	
	var self = this;
	this.getTiddlerFileInfo(tiddler,function(err,fileInfo) {
		var template, content, encoding;
		function _finish() {
			callback(null, {}, 0);
		}
		if(err) {
			return callback(err);
		}
		if(fileInfo.hasMetaFile) {
			// Save the tiddler as a separate body and meta file
			var typeInfo = $tw.config.typeInfo[fileInfo.type],
				encoding = typeInfo.encoding || "base64"; // makes sense for TW
			self.logger.log("saving type", fileInfo.type, "with meta file and encoding", encoding);
			fs.writeFile(fileInfo.filepath,tiddler.fields.text,{encoding: encoding},function(err) {
				if(err) {
					return callback(err);
				}
				content = self.wiki.renderTiddler("text/plain","$:/core/templates/tiddler-metadata",{variables: {currentTiddler: tiddler.fields.title}});
				fs.writeFile(fileInfo.filepath + ".meta",content,{encoding: "utf8"},function (err) {
					if(err) {
						return callback(err);
					}
					self.logger.log("Saved file",fileInfo.filepath);
					_finish();
				});
			});
		} else {
			// Save the tiddler as a self contained templated file
			template = $tw.config.typeTemplates[fileInfo.type];
			content = self.wiki.renderTiddler("text/plain",template,{variables: {currentTiddler: tiddler.fields.title}});
			fs.writeFile(fileInfo.filepath,content,{encoding: "utf8"},function (err) {
				if(err) {
					return callback(err);
				}
				self.logger.log("Saved file",fileInfo.filepath);
				_finish();
			});
		}
	});
};

/*
Load a tiddler and invoke the callback with (err,tiddlerFields)

We don't need to implement loading for the file system adaptor, because all the tiddler files will have been loaded during the boot process.
*/
HierarchicalFileSystemAdaptor.prototype.loadTiddler = function(title,callback) {
	callback(null,null);
};

/*
Delete a tiddler and invoke the callback with (err)
*/
HierarchicalFileSystemAdaptor.prototype.deleteTiddler = function(title,callback,options) {
	if(this.config.disabled) {
		this.logger.log("deleting disabled");
		return callback(null);
	}

	var self = this,
		fileInfo = $tw.boot.files[title];
	// Only delete the tiddler if we have writable information for the file
	if(fileInfo) {
		// Delete the file
		fs.unlink(fileInfo.filepath,function(err) {
			if(err) {
				return callback(err);
			}
			self.logger.log("Deleted file",fileInfo.filepath);
			// Delete the metafile if present
			if(fileInfo.hasMetaFile) {
				fs.unlink(fileInfo.filepath + ".meta",function(err) {
					if(err) {
						return callback(err);
					}
					callback(null);
				});
			} else {
				callback(null);
			}
		});
	} else {
		callback(null);
	}
};

if(fs) {
	exports.adaptorClass = HierarchicalFileSystemAdaptor;
}

})();