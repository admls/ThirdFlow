/*\
created: 20141012162041927
modified: 20141012163305588
module-type: folderpolicy
title: $:/plugins/TheDiveO/ThirdFlow/folderpolicies/draft.js
type: application/javascript
priority: 200

This folder usher places draft tiddlers flat into their own separate drafts folder.
The exact name of the drafts folder is configurable.
\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

var configTiddler = "$:/config/FileStorage/draftfoldername";
var draftFolderName;

// The configuration tiddler to monitor for changes
exports.watch = "[field:title[" + configTiddler + "]]";

// We get notified when our configuration tiddler was changed. Please
// note that title is undefined during inital configuration call.
exports.reconfig = function() {
	draftFolderName = $tw.wiki.getTiddlerText(configTiddler, "drafts").replace(new RegExp("\r?\n", "mg"), "");
	this.logger.log("folder policy config: draft: draft subfolder is: " + draftFolderName);
};

exports.folderpolicy = function(title, options) {
	if(options.draft) {
		options.subfolder = draftFolderName;
		return true;
	}
	return false;
};

})();
