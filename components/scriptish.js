const DESCRIPTION = "ScriptishService";
const CONTRACTID = "@scriptish.erikvold.com/scriptish-service;1";
const CLASSID = Components.ID("{ca39e060-88ab-11df-a4ee-0800200c9a66}");

const Cu = Components.utils;
Cu.import("resource://scriptish/constants.js");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

const serviceFilename = Components.stack.filename;

function ScriptishService() {
  this.wrappedJSObject = this;

  this.updateChk = function() {
    Scriptish_Services.mssl
        .loadSubScript("chrome://scriptish/content/js/updatecheck.js");
    this.updateChk = false;
  }
}

ScriptishService.prototype = {
  classDescription:  DESCRIPTION,
  classID:           CLASSID,
  contractID:        CONTRACTID,
  _xpcom_categories: [{category: "content-policy",
                       entry: CONTRACTID,
                       value: CONTRACTID,
                       service: true}],

  // nsISupports
  QueryInterface: XPCOMUtils.generateQI([
      Ci.nsISupports,
      Ci.nsISupportsWeakReference,
      Ci.nsIContentPolicy
  ]),

  get filename() { return serviceFilename; },
  _scriptFoldername: "scriptish_scripts",

  _config: null,
  get config() {
    if (!this._config) {
      if (this.updateChk) this.updateChk();
      var tools = {};
      Cu.import("resource://scriptish/config/config.js", tools);
      this._config = new tools.Config(this._scriptFoldername);
    }

    return this._config;
  },

  domContentLoaded: function(wrappedContentWin, chromeWin, gmBrowser) {
    var url = wrappedContentWin.document.location.href;
    var scripts = this.initScripts(url, wrappedContentWin, chromeWin);

    if (scripts.length > 0) {
      this.injectScripts(scripts, url, wrappedContentWin, chromeWin, gmBrowser);
    }
  },

  shouldLoad: function(ct, cl, org, ctx, mt, ext) {
    var tools = {};
    Cu.import("resource://scriptish/utils/Scriptish_installUri.js", tools);
    Cu.import("resource://scriptish/utils/Scriptish_getEnabled.js", tools);

    var ret = Ci.nsIContentPolicy.ACCEPT;

    // block content detection of scriptish by denying it
    // chrome content, unless loaded from chrome
    if (org && org.scheme != "chrome" && cl.scheme == "chrome" &&
        cl.host == "scriptish") {
      return Ci.nsIContentPolicy.REJECT_SERVER;
    }

    // don't intercept anything when Scriptish is not enabled
    if (!tools.Scriptish_getEnabled()) return ret;

    // don't interrupt the view-source: scheme
    // (triggered if the link in the error console is clicked)
    if ("view-source" == cl.scheme) return ret;

    if (ct == Ci.nsIContentPolicy.TYPE_DOCUMENT &&
        cl.spec.match(/\.user\.js$/)) {

      dump("shouldload: " + cl.spec + "\n");
      dump("ignorescript: " + this.ignoreNextScript_ + "\n");

      if (!this.ignoreNextScript_ &&
          !this.isTempScript(cl)) {
        tools.Scriptish_installUri(cl, ctx.contentWindow);
        ret = Ci.nsIContentPolicy.REJECT_REQUEST;
      }
    }

    this.ignoreNextScript_ = false;
    return ret;
  },

  shouldProcess: function(ct, cl, org, ctx, mt, ext) {
    return Ci.nsIContentPolicy.ACCEPT;
  },

  ignoreNextScript: function() {
    dump("ignoring next script...\n");
    this.ignoreNextScript_ = true;
  },

  isTempScript: function(uri) {
    if (uri.scheme != "file") return false;

    var fph = Cc["@mozilla.org/network/protocol;1?name=file"]
        .getService(Ci.nsIFileProtocolHandler);

    var file = fph.getFileFromURLSpec(uri.spec);
    var tmpDir = Services.dirsvc.get("TmpD", Ci.nsILocalFile);

    return file.parent.equals(tmpDir) && file.leafName != "newscript.user.js";
  },

  initScripts: function(url, wrappedContentWin, chromeWin) {
    var scripts;
    var tools = {};
    Cu.import("resource://scriptish/prefmanager.js", tools);

    // Todo: Try to implement this w/out global state.
    this.config.wrappedContentWin = wrappedContentWin;
    this.config.chromeWin = chromeWin;

    if (tools.Scriptish_prefRoot.getValue('enableScriptRefreshing')) {
      this.config.updateModifiedScripts();
    }

    var basicCheck = function(script) {
      return !script.delayInjection && script.enabled &&
          !script.needsUninstall && script.matchesURL(url);
    };

    // is the window the top most window in the iframe stack?
    if (wrappedContentWin !== wrappedContentWin.top) {
      scripts = this.config.getMatchingScripts(function(script) {
        return !script.noframes && basicCheck(script);
      });
    } else {
      scripts = this.config.getMatchingScripts(basicCheck);
    }

    return scripts;
  },

  injectScripts: function(scripts, url, wrappedContentWin, chromeWin, gmBrowser) {
    var sandbox;
    var script;
    var unsafeContentWin = wrappedContentWin.wrappedJSObject;

    var tools = {};
    Cu.import("resource://scriptish/api/GM_console.js", tools);
    Cu.import("resource://scriptish/api.js", tools);

    // detect and grab reference to firebug console and context, if it exists
    var firebugConsole = this.getFirebugConsole(unsafeContentWin, chromeWin);

    for (var i = 0; script = scripts[i]; i++) {
      sandbox = new Cu.Sandbox(wrappedContentWin);

      var GM_API = new tools.GM_API(
          script,
          url,
          wrappedContentWin.document,
          unsafeContentWin,
          Scriptish_Services.ass.hiddenDOMWindow,
          chromeWin,
          gmBrowser);

      sandbox.unsafeWindow = unsafeContentWin;

      // hack XPathResult since that is so commonly used
      sandbox.XPathResult = Ci.nsIDOMXPathResult;

      // add our own APIs
      for (var funcName in GM_API) sandbox[funcName] = GM_API[funcName];
      sandbox.console =
          firebugConsole ? firebugConsole : new tools.GM_console(script);

      sandbox.__proto__ = wrappedContentWin;

      var contents = script.textContent;

      var requires = [];
      var offsets = [];
      var offset = 0;
      var reqContents;

      for (var j = 0; j < script.requires.length; j++) {
        requires.push(reqContents = script.requires[j].textContent);
        offsets.push(offset += reqContents.split("\n").length)
      }
      script.offsets = offsets;

      var scriptSrc = "\n" + // error line-number calculations depend on these
          requires.join("\n") + "\n" +
          contents + "\n";

      if (!script.unwrap) scriptSrc = "(function(){"+ scriptSrc +"})()";
      if (!this.evalInSandbox(scriptSrc, sandbox, script) && script.unwrap) {
        // wrap anyway on early return
        this.evalInSandbox(
            "(function(){"+ scriptSrc +"})()", sandbox, script);
      }
    }
  },

  evalInSandbox: function(code, sandbox, script) {
    var tools = {};
    Cu.import("resource://scriptish/logging.js", tools);

    try {
      // workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=307984
      var lineFinder = new Error();
      Cu.evalInSandbox(code, sandbox, script.jsversion);
    } catch (e) { // catches errors while running the script code
      try {
        if (e && "return not in function" == e.message) {
          return false; // means this script depends on the function enclosure
        }

        // try to find the line of the actual error line
        var line = e && e.lineNumber;
        if (4294967295 == line) {
          // Line number is reported as max int in edge cases.  Sometimes
          // the right one is in the "location", instead.  Look there.
          if (e.location && e.location.lineNumber) {
            line = e.location.lineNumber;
          } else {
            // Reporting maxint is useless, if we couldn't find it in location
            // either, forget it.  A value of 0 isn't shown in the console.
            line = 0;
          }
        }

        if (line) {
          Cu.import("resource://scriptish/utils/Scriptish_findError.js", tools);
          var err = tools.Scriptish_findError(
              script, line - lineFinder.lineNumber - 1);

          tools.Scriptish_logError(
            e, // error obj
            0, // 0 = error (1 = warning)
            err.uri,
            err.lineNumber
          );
        } else {
          tools.Scriptish_logError(
            e, // error obj
            0, // 0 = error (1 = warning)
            script.fileURL,
            0
          );
        }
      } catch (e) { // catches errors we cause trying to inform the user
        // Do nothing. More importantly: don't stop script incovation sequence.
      }
    }
    return true; // did not need a (function() {...})() enclosure.
  },

  getFirebugConsole: function(unsafeContentWin, chromeWin) {
    // If we can't find this object, there's no chance the rest of this
    // function will work.
    if ('undefined'==typeof chromeWin.Firebug) return null;

    try {
      chromeWin = chromeWin.top;
      var fbVersion = parseFloat(chromeWin.Firebug.version, 10);
      var fbConsole = chromeWin.Firebug.Console;
      var fbContext = chromeWin.TabWatcher &&
        chromeWin.TabWatcher.getContextByWindow(unsafeContentWin);

      // Firebug 1.4 will give no context, when disabled for the current site.
      // We can't run that way.
      if ('undefined'==typeof fbContext) {
        return null;
      }

      function findActiveContext() {
        for (var i=0; i<fbContext.activeConsoleHandlers.length; i++) {
          if (fbContext.activeConsoleHandlers[i].window == unsafeContentWin) {
            return fbContext.activeConsoleHandlers[i];
          }
        }
        return null;
      }

      if (!fbConsole.isEnabled(fbContext)) return null;

      if (1.2 == fbVersion) {
        var tools = {};
        Services.scriptloader
            .loadSubScript("chrome://global/content/XPCNativeWrapper.js", tools);
        var safeWin = new tools.XPCNativeWrapper(unsafeContentWin);

        if (fbContext.consoleHandler) {
          for (var i = 0; i < fbContext.consoleHandler.length; i++) {
            if (fbContext.consoleHandler[i].window == safeWin) {
              return fbContext.consoleHandler[i].handler;
            }
          }
        }

        var dummyElm = safeWin.document.createElement("div");
        dummyElm.setAttribute("id", "_firebugConsole");
        safeWin.document.documentElement.appendChild(dummyElm);
        chromeWin.Firebug.Console.injector.addConsoleListener(fbContext, safeWin);
        dummyElm.parentNode.removeChild(dummyElm);

        return fbContext.consoleHandler.pop().handler;
      } else if (fbVersion >= 1.3) {
        fbConsole.injector.attachIfNeeded(fbContext, unsafeContentWin);
        return findActiveContext();
      }
    } catch (e) {
      dump('Scriptish getFirebugConsole() error:\n'+uneval(e)+'\n');
    }

    return null;
  }
};

// XPCOMUtils.generateNSGetFactory was introduced in Mozilla 2 (Firefox 4).
var NSGetFactory = XPCOMUtils.generateNSGetFactory([ScriptishService]);
