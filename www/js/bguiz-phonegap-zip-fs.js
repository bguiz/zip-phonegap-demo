'use strict';

var MAX_CONCURRENT_INFLATE = 512;
var MAX_CONCURRENT_SIZE_COST = 2 * 1024 * 1024;

function writeOutMessage(message) {
  var elem = document.getElementById('out');
  elem.appendChild(document.createTextNode(message));
  elem.appendChild(document.createElement('br'));
}

function extractZip(options, onDone) {
  zip.useWebWorkers = options.useWebWorkers;
  zip.workerScripts = options.workerScripts;
  var reader;
  switch (options.readerType) {
    case 'HttpReader':
      reader = new zip.HttpReader(options.readerUrl);
      break;
    default:
      throw 'Unrecognised zip reader type: '+options.readerType;
  }

  zip.createReader(reader, function onZipReaderCreated(zipReader) {
    zipReader.getEntries(function onZipEntriesListed(entries) {
      console.log(options.name, 'entries.length:', entries.length);
      var resultCount = entries.length;
      var concurrentEntries = 0;
      var concurrentCost = 0;
      var entryIndex = 0;

      function doNextEntry() {
        if (entryIndex >= entries.length) {
          return;
        }
        var entry = entries[entryIndex];
        var estimatedSizeCost =
          entry.uncompressedSize * (entry.uncompressedSize / entry.compressedSize);
        ++entryIndex;
        ++concurrentEntries;
        concurrentCost += estimatedSizeCost;

        var writer;
        switch (options.writerType) {
          case 'Data64URIWriter':
            writer = new zip.Data64URIWriter(zip.getMimeType(entry.fileName));
            break;
          default:
            throw 'Unrecognised zip writer type: '+options.writerType;
        }
        entry.getData(writer, function onGotDataForZipEntry(data) {
          onDone(undefined, false, {
            fileName: entry.fileName,
            contents: data,
          });

          --concurrentEntries;
          --resultCount;
          concurrentCost -= estimatedSizeCost;
          if (resultCount < 1) {
            onDone(undefined, true);
          }
          else {
            doRateLimitedNextEntries();
          }
        });
      }

      // In V8, if we spawn too many CPU intensive callback functions
      // at once, it is smart enough to rate limit it automatically
      // This, however, is not the case for other Javascript VMs,
      // so we need to implement by hand a means to
      // limit the max number of concurrent operations
      function doRateLimitedNextEntries() {
        while (concurrentEntries < 1 ||
               (concurrentEntries <= MAX_CONCURRENT_INFLATE &&
                concurrentCost <= MAX_CONCURRENT_SIZE_COST)) {
          doNextEntry();
        }
      }

      doRateLimitedNextEntries();
    });
  }, function onZipReaderCreateFailed(err) {
    console.error(err, err.stack);

    writeOutMessage('Error: '+err);
    writeOutMessage('Error: '+err.stack);

    throw err;
  });
}

function getDataFile(path, options, onGotFileEntry) {
  options = options || {};
  window.requestFileSystem(LocalFileSystem.PERSISTENT, 0, function onGotFileSytem(fileSys) {
    console.log("got main fileSys", fileSys);
    fileSys.root.getFile(path, options, function(fileEntry) {
      console.log("got the fileEntry", fileEntry);
      onGotFileEntry(undefined, fileEntry);
    }, function onFail(err) {
      console.log('Err', err);
      throw err;
    });
  }, function onFail(err) {
    console.log('Err', err);
    throw err;
  });
}

function writeFile(options, onDone) {
  getDataFile(options.name, options.flags, function onGotFileEntry(err, fileEntry) {
    if (!!err) {
      onFail(err);
    }
    fileEntry.createWriter(function onWriterCreated(writer) {
      var blob = new Blob([options.content], { type: options.mimeType });
      writer.onwriteend = onWrote;
      writer.write(blob);

      function onWrote(evt) {
        onDone(writer.error, evt);
      }
    }, onFail);
  }, onFail);
}

function readFile(options, onDone) {
  getDataFile(options.name, options.flags, function onGotFileEntry(err, fileEntry) {
    if (!!err) {
      onFail(err);
    }
    fileEntry.file(function onGotFile(file) {
      var reader = new FileReader();
      reader.onloadend = onRead;
      switch(options.method) {
        case 'readAsText':
        case 'readAsDataURL':
        case 'readAsBinaryString':
        case 'readAsArrayBuffer':
          reader[options.method](file);
          break;
        default:
          throw 'Unrecognised file reader method: '+ options.method;
      }

      function onRead(evt) {
        onDone(reader.error, evt);
      }
    }, onFail);
  }, onFail);
}
