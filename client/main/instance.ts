//
// Copyright (C) 2016 Jonathon Love
//

"use strict";

import { $ } from "jquery";

const Backbone = require("backbone");
Backbone.$ = $;
const path = require("path");

const host = require("./host");
const Notify = require("./notification");

const Analyses = require("./analyses");
const DataSetViewModel = require("./dataset");
const OptionsPB = require("./optionspb");
const Modules = require("./modules");
const I18n = require("../common/i18n");

const Settings = require("./settings");
const ProgressStream = require("./utils/progressstream");

const { flatten, unflatten } = require("../common/utils/addresses");

import { UserFacingError } from "./errors";
import { CancelledError } from "./errors";

class FileExistsError extends Error {}

interface CreateAnalysisOptions {
  readonly name: string;
  readonly ns: string;
  readonly title: string;
  readonly index?: number;
  readonly onlyOne?: boolean;
}

import { parse as parseJsonLines } from "./utils/jsonlines";

const Instance = Backbone.Model.extend({
  initialize() {
    this.transId = 0;
    this.command = "";
    this.seqNo = 0;

    this._settings = new Settings({ coms: this.attributes.coms });
    this._modules = new Modules({ instance: this });

    this._dataSetModel = new DataSetViewModel({ coms: this.attributes.coms });
    this._dataSetModel.on("columnsChanged", this._columnsChanged, this);

    this._analyses = new Analyses({
      modules: this._modules,
      dataSetModel: this._dataSetModel,
    });

    this._analyses.on("analysisOptionsChanged", this._onOptionsChanged, this);

    this._instanceId = null;

    this._onBC = (bc) => this._onReceive(bc);
    this.attributes.coms.on("broadcast", this._onBC);
  },
  _onOptionsChanged(analysis, incoming) {
    if (!incoming) this._runAnalysis(analysis);
  },
  destroy() {
    this._dataSetModel.off("columnsChanged", this._columnsChanged, this);
    this._analyses.off("analysisOptionsChanged", this._onOptionsChanged, this);
    this.attributes.coms.off("broadcast", this._onBC);
    this._settings.destroy();
  },
  defaults: {
    coms: null,
    selectedAnalysis: null,
    hasDataSet: false,
    path: null,
    title: "",
    blank: false,
    resultsSupplier: null,
    arbitraryCodePresent: false,
    editState: false,
  },
  instanceId() {
    return this._instanceId;
  },
  dataSetModel() {
    return this._dataSetModel;
  },
  analyses() {
    return this._analyses;
  },
  settings() {
    return this._settings;
  },
  modules() {
    return this._modules;
  },
  connect(instanceId) {
    let coms = this.attributes.coms;

    return coms
      .connect()
      .then(() => {
        return this._beginInstance(instanceId);
      })
      .then(() => {
        return this._settings.retrieve(this._instanceId);
      })
      .then(() => {
        return this._readDataset();
      })
      .then(() => {
        return this._instanceId;
      });
  },
  import(paths) {
    let coms = this.attributes.coms;

    let progress = new Notify({
      title: _("Importing"),
      duration: 0,
    });

    let open = new coms.Messages.OpenRequest();
    open.filePaths = paths;
    open.op = coms.Messages.OpenRequest.Op.IMPORT_REPLACE;

    let request = new coms.Messages.ComsMessage();
    request.payload = open.toArrayBuffer();
    request.payloadType = "OpenRequest";
    request.instanceId = this._instanceId;

    return coms.send(request).then(
      (response) => {
        progress.dismiss();
        this._readDataset(false);
        this._notify({
          message: _("File imported"),
          cause: _("Import successful"),
        });
      },
      (error) => {
        progress.dismiss();
        // we still have to retrieveInfo() on failure, because the import
        // may have failed on, say, the second data set, and the data set
        // will still have changed
        this._readDataset(false);
        this._notify(error);
      },
      (prog) => {
        progress.set("progress", prog);
        this.trigger("notification", progress);
        return prog;
      }
    );
  },
  open(file, options) {
    options = options || {};

    // nuke any vestigal path ... this will be tidied up at some point
    options = Object.assign({}, options);
    delete options.path;

    return new ProgressStream(async (setProgress) => {
      let response;
      let welcomeUrl;

      let headers = new Headers();
      headers.append("Accept-Language", I18n.language);

      if (options.authToken)
        headers.append("Authorization", `Bearer ${options.authToken}`);

      while (true) {
        if (file instanceof File) {
          // fetch doesn't support upload progress, so we need to use xhr
          let xhr = new XMLHttpRequest();
          xhr.responseType = "text"; // json lines

          // create a body stream that's kinda like what the fetch api produces
          let stream = new ReadableStream({
            async start(controller) {
              await new Promise<void>((resolve) => {
                xhr.addEventListener("progress", (event) => {
                  let jsonlines = xhr.responseText;
                  if (jsonlines) {
                    let pieces = jsonlines.split("\n");
                    // if the last piece is empty (in jsonlines this will often be the case)
                    // use the second last piece instead
                    let lastPiece =
                      pieces[pieces.length - 1] || pieces[pieces.length - 2];
                    if (lastPiece) controller.enqueue(lastPiece);
                  }
                });
                xhr.addEventListener(
                  "loadend",
                  () => {
                    if (xhr.readyState === 0)
                      // aborted
                      controller.close();
                    else if (xhr.readyState === 4 && xhr.status === 200)
                      // great success!
                      controller.close();
                    // fail
                    else
                      controller.error(
                        new UserFacingError(_("Upload failed"), {
                          cause: xhr.statusText,
                        })
                      );
                    resolve();
                  },
                  { once: true }
                );
              });
            },
          });

          setProgress({
            title: _("Uploading"),
            p: 0,
            n: 0,
            cancel: () => xhr.abort(),
          });

          xhr.upload.addEventListener("progress", (event) => {
            if (event.lengthComputable)
              setProgress({
                title: _("Uploading"),
                p: event.loaded,
                n: event.total,
                cancel: () => xhr.abort(),
              });
          });

          let url = `${host.baseUrl}open?p=`;

          const data = new FormData();
          data.append("options", JSON.stringify(options));
          data.append("file", file, file.name);

          xhr.open("POST", url, true);
          for (let header of headers.entries())
            xhr.setRequestHeader(header[0], header[1]);
          xhr.send(data);

          // wait till upload completes
          await new Promise<void>((resolve) => {
            xhr.addEventListener("readystatechange", (event) => {
              if (xhr.readyState !== XMLHttpRequest.OPENED) resolve();
            });
          });

          if (xhr.status === 0)
            // aborted
            throw new CancelledError();

          if (xhr.status === 204) return { status: "OK" };

          if (xhr.status === 413)
            throw new UserFacingError(_("Upload failed"), {
              cause: "File size exceeds session limits",
            });

          if (xhr.status !== 200)
            throw new UserFacingError(_("Upload failed"), {
              cause: xhr.statusText,
            });

          // if we're here, the upload succeeded, and the opening
          // process comes next (which may yet fail)
          // we construct a response something like what the fetch() api returns
          response = {
            status: xhr.status,
            statusText: xhr.statusText,
            body: stream,
          };
        } else {
          if (file === undefined || file === null) {
            let url = "open?p=";

            if (options.accessKey) url += `&key=${options.accessKey}`;

            response = await fetch(url, {
              method: "GET",
              credentials: "include",
              cache: "no-store",
              headers: headers,
            });
          } else {
            const data = new FormData();
            data.append(
              "options",
              JSON.stringify(Object.assign({ path: file }, options))
            );

            response = await fetch("open?p=", {
              method: "POST",
              body: data,
              credentials: "include",
              cache: "no-store",
              headers: headers,
            });
          }

          if (response.status === 204) return { status: "OK" };

          if (response.status === 413)
            throw new UserFacingError(_("Unable to open"), {
              cause: "File size exceeds session limits",
            });

          if (response.status !== 200)
            throw new UserFacingError(_("Unable to open"), {
              cause: response.statusText,
            });
        }

        const reader = response.body.getReader();
        const utf8Decoder = new TextDecoder("utf-8");

        let message;
        for (;;) {
          let { done, value } = await reader.read();

          let pieces;
          if (typeof value === "string") pieces = value.split("\n");
          else if (!value) pieces = [];
          else pieces = utf8Decoder.decode(value).split("\n");

          // if the last piece is empty (in jsonlines this will often be the case)
          // use the second last piece instead
          let lastPiece =
            pieces[pieces.length - 1] || pieces[pieces.length - 2];
          if (lastPiece) {
            try {
              message = JSON.parse(lastPiece);
            } catch (e) {
              message = null;
            }
          }

          if (message && message.status === "in-progress") {
            if (!message.title) message.title = _("Opening");
            setProgress(message);
          }

          if (done) break;
        }

        if (message && message["set-cookies"]) {
          for (let cookie of message["set-cookies"]) document.cookie = cookie;
        }

        if (!message) {
          throw new UserFacingError(_("Unable to open"), {
            cause: _("Unexpected error"),
            status: "error",
          });
        } else if (
          message.status !== "OK" &&
          message.status !== "requires-auth"
        ) {
          let title = message.title || _("Unable to open");
          throw new UserFacingError(title, {
            cause: message.message || _("Unexpected error"),
            status: message.status || "error",
            messageSrc: message["message-src"],
          });
        } else if (message.url === "/open") {
          // open is performed in two steps, so we store the welcome
          // message from the first step
          welcomeUrl = message["message-src"];
          continue;
        } else {
          // and apply the welcome message to the second
          if (!("message-src" in message) && welcomeUrl !== undefined)
            message["message-src"] = welcomeUrl;
          return message;
        }
      }
    });
  },
  async save(options) {
    options = Object.assign({}, options); // clone so we can modify without side-effects

    const progress = new Notify({
      title: _("Saving"),
      duration: 0,
    });

    if (!options.path) {
      // no path means a 'save' (rather than a 'save as')
      options.path = this.attributes.path;
      options.format = this.attributes.saveFormat;
      options.overwrite = true;
    }

    let filename = path.basename(options.path);
    let retrying;

    do {
      retrying = false;

      try {
        const stream = this._save(options);

        for await (const message of stream) {
          progress.set("progress", message);
          this.trigger("notification", progress);
        }

        const result = await stream;

        filename = result.filename;

        if (!options.export) {
          this.set("path", result.path);
          this.set("title", result.title);
          this.set("saveFormat", result.saveFormat);
          this._dataSetModel.set("edited", false);

          this._notify({
            message: _("File Saved"),
            cause: _(`Saved to '{filename}'`, { filename }),
          });
        } else {
          if (result.download) return result;
          else
            this._notify({
              message: _("Exported"),
              cause: _(`Exported to '{filename}'`, { filename }),
            });
        }
      } catch (e) {
        if (e instanceof FileExistsError && !options.overwrite) {
          const response = window.confirm(
            _(`The file '{filename}' already exists. Overwrite this file?`, {
              filename,
            }),
            _("Confirm overwite")
          );
          if (response) {
            options.overwrite = true;
            retrying = true;
          }
        } else if (e instanceof UserFacingError) {
          this._notify({ message: e.message, cause: e.cause, type: "error" });
          throw e;
        } else {
          this._notify({
            message: _("Save failed"),
            cause: e.message || "",
            type: "error",
          });
          throw e;
        }
      } finally {
        progress.dismiss();
      }
    } while (retrying);

    return {};
  },
  _save(options) {
    options = Object.assign({}, options); // clone so we can modify without side-effects

    return new ProgressStream(async (setProgress) => {
      const app = await host.nameAndVersion;

      // Generate content if necessary
      let content = null;

      if (options.content) {
        content = options.content;
        delete options.content;
      } else if (options.partType === "image") {
        // images are handled specially below
      } else if (
        options.path.endsWith(".omv") ||
        options.format === "abs-html"
      ) {
        content = await this.attributes.resultsSupplier.getAsHTML({
          images: "relative",
          generator: app,
        });
      } else if (
        options.path.endsWith(".html") ||
        options.path.endsWith(".htm")
      ) {
        content = await this.attributes.resultsSupplier.getAsHTML(
          { images: "inline", generator: app },
          options.part
        );
      } else if (options.path.endsWith(".zip")) {
        content = await this.attributes.resultsSupplier.getAsHTML(
          { images: "relative", generator: app },
          options.part
        );
      } else if (options.path.endsWith(".pdf")) {
        let images = host.isElectron ? "absolute" : "inline";
        const html = await this.attributes.resultsSupplier.getAsHTML(
          { images: images, generator: app },
          options.part
        );
        content = await this._requestPDF(html);
      }

      const data = new FormData();
      data.append("options", JSON.stringify(options));
      if (content) data.append("content", new Blob([content]));

      const response = await fetch("save", {
        method: "POST",
        body: data,
      });

      if (![200, 204].includes(response.status))
        throw new Error(response.statusText);

      const reader = response.body.getReader();
      const stream = parseJsonLines(reader);

      for await (const message of stream) setProgress(message);

      const result = await stream;

      if (result.status === "OK") {
        return result;
      } else if (result.code === "file-exists") {
        throw new FileExistsError();
      } else {
        throw new UserFacingError(_("Save failed"), {
          cause: result.message || "",
        });
      }
    });
  },
  browse(filePath, extensions) {
    let coms = this.attributes.coms;

    let fs = new coms.Messages.FSRequest();
    fs.path = filePath;
    fs.extensions = extensions;

    let message = new coms.Messages.ComsMessage();
    message.payload = fs.toArrayBuffer();
    message.payloadType = "FSRequest";
    message.instanceId = this.instanceId();

    let promise = coms.send(message);
    promise = promise.then((response) => {
      return coms.Messages.FSResponse.decode(response.payload);
    });
    return promise;
  },
  restartEngines() {
    let coms = this.attributes.coms;

    let analysisRequest = new coms.Messages.AnalysisRequest();
    analysisRequest.restartEngines = true;

    let request = new coms.Messages.ComsMessage();
    request.payload = analysisRequest.toArrayBuffer();
    request.payloadType = "AnalysisRequest";
    request.instanceId = this._instanceId;

    return coms.sendP(request);
  },
  retrieveAvailableModules() {
    let coms = this.attributes.coms;

    let storeRequest = new coms.Messages.StoreRequest();

    let request = new coms.Messages.ComsMessage();
    request.payload = storeRequest.toArrayBuffer();
    request.payloadType = "StoreRequest";
    request.instanceId = this._instanceId;

    return coms.send(request).then(
      (response) => {
        return coms.Messages.StoreResponse.decode(response.payload);
      },
      (error) => {
        throw error;
      }
    );
  },
  installModule(filePath) {
    let coms = this.attributes.coms;

    let moduleRequest = new coms.Messages.ModuleRR();
    moduleRequest.command = coms.Messages.ModuleRR.ModuleCommand.INSTALL;
    moduleRequest.path = filePath;

    let request = new coms.Messages.ComsMessage();
    request.payload = moduleRequest.toArrayBuffer();
    request.payloadType = "ModuleRR";
    request.instanceId = this._instanceId;

    return coms.send(request);
  },
  uninstallModule(name) {
    let coms = this.attributes.coms;

    let moduleRequest = new coms.Messages.ModuleRR();
    moduleRequest.command = coms.Messages.ModuleRR.ModuleCommand.UNINSTALL;
    moduleRequest.name = name;

    let request = new coms.Messages.ComsMessage();
    request.payload = moduleRequest.toArrayBuffer();
    request.payloadType = "ModuleRR";
    request.instanceId = this._instanceId;

    return coms.send(request);
  },
  setModuleVisibility(name, value) {
    let coms = this.attributes.coms;

    let moduleRequest = new coms.Messages.ModuleRR();
    if (value === false)
      moduleRequest.command = coms.Messages.ModuleRR.ModuleCommand.HIDE;
    else moduleRequest.command = coms.Messages.ModuleRR.ModuleCommand.SHOW;

    moduleRequest.name = name;

    let request = new coms.Messages.ComsMessage();
    request.payload = moduleRequest.toArrayBuffer();
    request.payloadType = "ModuleRR";
    request.instanceId = this._instanceId;

    return coms.send(request);
  },
  trustArbitraryCode() {
    for (let analysis of this.analyses()) {
      if (analysis.arbitraryCode && !analysis.enabled) analysis.enable();
    }
  },
  _notify(error) {
    let notification = new Notify({
      title: error.message,
      message: error.cause,
      duration: 3000,
      type: error.type ? error.type : "info",
    });
    this.trigger("notification", notification);
  },
  _beginInstance(instanceId) {
    let coms = this.attributes.coms;

    let instanceRequest = new coms.Messages.InstanceRequest();
    let request = new coms.Messages.ComsMessage();
    request.payload = instanceRequest.toArrayBuffer();
    request.payloadType = "InstanceRequest";

    if (instanceId) request.instanceId = instanceId;

    return coms.send(request).then((response) => {
      this._instanceId = response.instanceId;
    });
  },
  async _readDataset(loadAnalyses = true) {
    let coms = this.attributes.coms;

    let info = new coms.Messages.InfoRequest();
    let request = new coms.Messages.ComsMessage();
    request.payload = info.toArrayBuffer();
    request.payloadType = "InfoRequest";
    request.instanceId = this._instanceId;

    let response = await coms.send(request);
    info = coms.Messages.InfoResponse.decode(response.payload);

    this._dataSetModel.set("instanceId", this._instanceId);

    if (info.hasDataSet) {
      this._dataSetModel.setup(info);
      this.set("hasDataSet", true);
      this.set("title", info.title);
      this.set("path", info.path);
      this.set("saveFormat", info.saveFormat);
      this.set("blank", info.blank);
    }

    if (loadAnalyses) {
      let allAnalysesReady = [];

      for (let analysisPB of info.analyses) {
        let options = OptionsPB.fromPB(analysisPB.options, coms.Messages);
        let analysis = await this._analyses.create({
          name: analysisPB.name,
          ns: analysisPB.ns,
          id: analysisPB.analysisId,
          options: options,
          results: analysisPB.results,
          references: analysisPB.references,
          enabled: analysisPB.enabled,
          arbitraryCode: analysisPB.arbitraryCode,
          dependsOn: analysisPB.dependsOn,
        });

        allAnalysesReady.push(analysis.ready);

        // sleep to allow iframes to load, etc. so it can progressively
        // update rather than waiting until the end
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await Promise.all(allAnalysesReady);

      for (let analysis of this._analyses) {
        if (analysis.arbitraryCode) this.set("arbitraryCodePresent", true);
        else analysis.enabled = true;
      }
    }

    return response;
  },
  async createAnalysis(opts: CreateAnalysisOptions) {
    let analysis: any;

    if (opts.onlyOne) {
      // onlyOne means we reuse an existing analysis (when present)
      for (let existing of this._analyses) {
        if (existing.ns === opts.ns && existing.name === opts.name) {
          analysis = existing;
          break;
        }
      }
    }

    if (!analysis) {
      analysis = await this._analyses.create({
        name: opts.name,
        ns: opts.ns,
        title: opts.title,
        index: opts.index,
        enabled: true,
      });
      this._sendAnalysis(analysis);
    }
    this.set("selectedAnalysis", analysis);
  },
  async duplicateAnalysis(dupliceeId) {
    let duplicee = this._analyses.get(dupliceeId);
    let index = duplicee.index + 2; //insert after proceeding annotation
    let analysis = await this._analyses.create({
      name: duplicee.name,
      ns: duplicee.ns,
      index: index,
      options: duplicee.options.getValues(),
      results: duplicee.results,
      enabled: duplicee.enabled,
      arbitraryCode: duplicee.arbitraryCode,
      references: duplicee.references,
    });
    this._sendAnalysis(analysis, duplicee);

    return analysis;
  },
  _optionsExtras() {
    let ppi = Math.trunc(72 * (window.devicePixelRatio || 1));
    let theme = this._settings.getSetting("theme", "default");
    let palette = this._settings.getSetting("palette", "jmv");

    return { ".ppi": ppi, theme: theme, palette: palette };
  },
  async _constructAnalysisRequest(analysis, options) {
    let coms = this.attributes.coms;

    let request = new coms.Messages.AnalysisRequest();
    request.analysisId = analysis.id;
    request.name = analysis.name;
    request.ns = analysis.ns;
    request.revision = analysis.revision;
    request.enabled = analysis.enabled;
    request.index = analysis.index + 1;
    request.i18n = await analysis.getCurrentI18nCode();

    if (options === undefined) {
      if (analysis.isReady) options = analysis.options;
      else options = {};
    }

    let extras = {};
    if (analysis.ns !== "jmv" || analysis.name !== "empty") {
      extras = this._optionsExtras();
      extras[".lang"] = await analysis.getCurrentI18nCode();
    }

    request.setOptions(OptionsPB.toPB(options, extras, coms.Messages));
    return request;
  },
  _sendAnalysisRequest(request, analysis) {
    let coms = this.attributes.coms;

    let message = new coms.Messages.ComsMessage();
    message.payload = request.toArrayBuffer();
    message.payloadType = "AnalysisRequest";
    message.instanceId = this._instanceId;

    return coms.sendP(message);
  },
  async _runAnalysis(analysis, changed) {
    let coms = this.attributes.coms;
    this._dataSetModel.set("edited", true);

    analysis.revision++;
    let request = await this._constructAnalysisRequest(analysis);
    request.perform = 0; // INIT

    if (changed) request.changed = changed;

    this._sendAnalysisRequest(request, analysis);
  },
  async _sendAnalysis(analysis, duplicee) {
    let coms = this.attributes.coms;
    this._dataSetModel.set("edited", true);

    let request = null;
    if (duplicee !== undefined) {
      request = await this._constructAnalysisRequest(analysis, {
        duplicate: duplicee.id,
      });
      request.perform = 7; // DUPLICATE
    } else {
      request = await this._constructAnalysisRequest(analysis);
      request.perform = 0; // INIT
    }

    this._sendAnalysisRequest(request, analysis);
  },
  async deleteAnalysis(analysis) {
    let coms = this.attributes.coms;
    this._dataSetModel.set("edited", true);
    let request = await this._constructAnalysisRequest(analysis);
    request.perform = 6; // DELETE
    this._sendAnalysisRequest(request, analysis);
  },
  deleteAll() {
    let coms = this.attributes.coms;
    this._dataSetModel.set("edited", true);
    let request = new coms.Messages.AnalysisRequest();
    request.analysisId = 0;
    request.perform = 6; // DELETE
    this._sendAnalysisRequest(request);
  },
  async _onReceive(payloadType, response) {
    let coms = this.attributes.coms;

    if (response === undefined) {
      let message = payloadType;
      payloadType = message.payloadType;
      if (!payloadType) return;

      response = coms.Messages[message.payloadType].decode(message.payload);
    }

    if (payloadType === "AnalysisRequest") {
      if (response.perform === 6) {
        // deleted
        if (response.analysisId === 0) this._analyses.onDeleteAll();
        else this._analyses.deleteAnalysis(response.analysisId);
        return;
      }
    } else if (payloadType === "AnalysisResponse") {
      let id = response.analysisId;
      let analysis = this._analyses.get(id);

      if (!analysis) {
        if (response.analysisId === 0) throw "Analysis Id can not be 0";

        if (response.analysisId % 2 === 0)
          throw `Analysis with id ${response.analysisId} does not exist.`;

        let options = OptionsPB.fromPB(response.options, coms.Messages);
        analysis = await this._analyses.create({
          name: response.name,
          title: response.hasTitle ? response.title : undefined,
          ns: response.ns,
          id: response.analysisId,
          options: options,
          results: response.results,
          references: response.references,
          enabled: response.enabled,
          index: response.index - 1,
          dependsOn: response.dependsOn,
        });

        if (response.name !== "empty") this.set("selectedAnalysis", analysis);
      } else {
        analysis.results.index = response.index;
        analysis.index = response.index - 1;

        let options = {};
        if (response.revision === analysis.revision)
          options = OptionsPB.fromPB(response.options, coms.Messages);

        let optionsApplied = false;
        if (analysis.isReady === false) {
          optionsApplied = true;
          analysis.setup(options);
        }

        if (response.results)
          analysis.setResults({
            results: response.results,
            options: !optionsApplied ? options : undefined,
            references: response.references,
            enabled: response.enabled,
            arbitraryCode: response.arbitraryCode,
          });
      }
    } else if (payloadType === "DataSetRR") {
      this._dataSetModel._processDatasetRR(response);
    } else if (payloadType === "ModuleRR") {
      let moduleName = response.name;
      this._modules.purgeCache(moduleName);

      for (let analysis of this._analyses) {
        if (analysis.ns === moduleName) analysis.reload();
      }

      this.trigger("moduleInstalled", { name: moduleName });
    } else if (payloadType === "Notification") {
      let n10n = Notify.createFromPB(response);
      this.trigger("notification", n10n);
    } else if (payloadType === "LogRR") {
      console.log(response.content);
    }
  },
  _columnsChanged(event) {
    this._dataSetModel.set("edited", true);

    for (let analysis of this._analyses) {
      if (analysis.isReady === false) continue;

      let using = analysis.getUsingColumns();

      let columnDataChanged = false;
      let columnDeleted = false;
      let columnRenamed = false;
      let levelsRenamed = false;
      let columnRenames = [];
      let levelRenames = [];
      let columnDeletes = [];

      for (let changes of event.changes) {
        if (changes.deleted) {
          if (using.includes(changes.name)) {
            columnDeleted = true;
            columnDeletes.push(changes.name);
          }
        } else {
          let column = this._dataSetModel.getColumnById(changes.id);
          if (using.includes(column.name)) {
            if (
              changes.transformChanged ||
              changes.parentIdChanged ||
              changes.activeChanged ||
              changes.columnTypeChanged ||
              changes.measureTypeChanged ||
              changes.dataTypeChanged ||
              changes.levelsChanged ||
              changes.formulaChanged ||
              changes.dataChanged ||
              changes.missingValuesChanged ||
              changes.descriptionChanged
            )
              columnDataChanged = true;
          }
          if (changes.nameChanged && using.includes(changes.oldName)) {
            columnRenamed = true;
            columnRenames.push({
              oldName: changes.oldName,
              newName: column.name,
            });
          }
          if (changes.levelsChanged) {
            levelsRenamed = changes.levelNameChanges.length > 0;
            for (let i = 0; i < changes.levelNameChanges.length; i++)
              levelRenames.push({
                variable: column.name,
                oldLabel: changes.levelNameChanges[i].oldLabel,
                newLabel: changes.levelNameChanges[i].newLabel,
              });
          }
        }
      }

      if (columnRenamed) analysis.notifyColumnsRenamed(columnRenames);

      if (levelsRenamed) analysis.notifyLevelsRenamed(levelRenames);

      if (columnDataChanged || columnRenamed || columnDeleted) {
        let selectedAnalysis = this.get("selectedAnalysis");
        if (selectedAnalysis !== null && selectedAnalysis.id === analysis.id)
          this.trigger("change:selectedAnalysis", {
            changed: { selectedAnalysis: analysis },
          });
      }
    }
  },
  _stringifyMeasureType(measureType) {
    switch (measureType) {
      case 2:
        return "nominal";
      case 3:
        return "ordinal";
      case 4:
        return "continuous";
      default:
        return "";
    }
  },
  _requestPDF(html) {
    return fetch("../utils/to-pdf", {
      method: "POST",
      body: html,
    }).then((response) => {
      if (response.status === 200) return response.arrayBuffer();
      else if (response.status === 500)
        return new Promise((resolve, reject) =>
          response.text().then((text) => reject(text))
        );
      else throw response.statusText;
    });
  },
});

module.exports = Instance;
