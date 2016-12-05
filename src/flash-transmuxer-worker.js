/**
 * @file flash-worker.js
 */

/**
 * videojs-contrib-media-sources
 *
 * Copyright (c) 2015 Brightcove
 * All rights reserved.
 *
 * Handles communication between the browser-world and the mux.js
 * transmuxer running inside of a WebWorker by exposing a simple
 * message-based interface to a Transmuxer object.
 */
import window from 'global/window';
import flv from 'mux.js/lib/flv';
import FlashConstants from './flash-constants';

/**
 * Assemble the FLV tags in decoder order
 *
 * @function orderTags
 * @param {Object} tags object containing video and audio tags
 * @return {Object} object containing the filtered array of tags and total bytelength
 */
const orderTags = function(tags) {
  let videoTags = tags.videoTags;
  let audioTags = tags.audioTags;
  let ordered = [];
  let tag;

  while (videoTags.length || audioTags.length) {
    if (!videoTags.length) {
      // only audio tags remain
      tag = audioTags.shift();
    } else if (!audioTags.length) {
      // only video tags remain
      tag = videoTags.shift();
    } else if (audioTags[0].dts < videoTags[0].dts) {
      // audio should be decoded next
      tag = audioTags.shift();
    } else {
      // video should be decoded next
      tag = videoTags.shift();
    }
    ordered.push(tag);
  }

  return ordered
};

/**
 * Turns an array of flv tags into a Uint8Array representing the
 * flv data.
 *
 * @function convertTagsToData
 * @param {Array} list of flv tags
 */
const convertTagsToData_ = function(tags, targetPts) {
  let filtered = [];
  let len = 0;

  for (let i = 0, l = tags.length; i < l; i++) {
    if (tags[i].pts >= targetPts) {
      filtered.push(tags[i]);
      len += tags[i].bytes.length;
    }
  }

  if (filtered.length === 0) {
    return [];
  }

  let segment = new Uint8Array(len);

  for (let i = 0, j = 0, l = filtered.length; i < l; i++) {
    segment.set(filtered[i].bytes, j);
    j += filtered[i].bytes.byteLength;
  }

  let b64Chunks = [];

  for (let chunkStart = 0, l = segment.byteLength;
    chunkStart < l; chunkStart += FlashConstants.BYTES_PER_CHUNK) {
    let chunkEnd = Math.min(chunkStart + FlashConstants.BYTES_PER_CHUNK, l);

    let chunk = segment.subarray(chunkStart, chunkEnd);

    let binary = [];

    for (let chunkByte = 0; chunkByte < chunk.byteLength; chunkByte++) {
      binary.push(String.fromCharCode(chunk[chunkByte]));
    }

    b64Chunks.push(window.btoa(binary.join('')));
  }

  return b64Chunks;
};

/**
 * Re-emits tranmsuxer events by converting them into messages to the
 * world outside the worker.
 *
 * @param {Object} transmuxer the transmuxer to wire events on
 * @private
 */
const wireTransmuxerEvents = function(transmuxer) {
  transmuxer.on('data', (segment) => {
    this.tags = orderTags(segment.tags);

    delete segment.tags;

    segment.basePts = this.tags[0].pts;
    segment.length = this.tags.length;

    window.postMessage({
      action: 'metadata',
      segment
    });
  });

  transmuxer.on('done', (data) => {
    window.postMessage({ action: 'done' });
  });
};

/**
 * All incoming messages route through this hash. If no function exists
 * to handle an incoming message, then we ignore the message.
 *
 * @class MessageHandlers
 * @param {Object} options the options to initialize with
 */
class MessageHandlers {
  constructor(options) {
    this.options = options || {};
    this.init();
    this.tags = [];
    this.targetPts_ = 0;
  }

  /**
   * initialize our web worker and wire all the events.
   */
  init() {
    if (this.transmuxer) {
      this.transmuxer.dispose();
    }
    this.transmuxer = new flv.Transmuxer(this.options);
    wireTransmuxerEvents.call(this, this.transmuxer);
  }

  convertTagsToData(data) {
    this.targetPts_ = data.targetPts;

    let b64 = convertTagsToData_(this.tags, this.targetPts_);

    window.postMessage({
      action:'data',
      b64
    });
  }

  /**
   * Adds data (a ts segment) to the start of the transmuxer pipeline for
   * processing.
   *
   * @param {ArrayBuffer} data data to push into the muxer
   */
  push(data) {
    // Cast array buffer to correct type for transmuxer
    let segment = new Uint8Array(data.data, data.byteOffset, data.byteLength);

    this.transmuxer.push(segment);
  }

  /**
   * Recreate the transmuxer so that the next segment added via `push`
   * start with a fresh transmuxer.
   */
  reset() {
    this.init();
  }

  /**
   * Forces the pipeline to finish processing the last segment and emit it's
   * results.
   *
   * @param {Object} data event data, not really used
   */
  flush(data) {
    this.transmuxer.flush();
  }
}

/**
 * Our web wroker interface so that things can talk to mux.js
 * that will be running in a web worker. the scope is passed to this by
 * webworkify.
 *
 * @param {Object} self the scope for the web worker
 */
const Worker = function(self) {
  self.onmessage = function(event) {
    if (event.data.action === 'init' && event.data.options) {
      this.messageHandlers = new MessageHandlers(event.data.options);
      return;
    }

    if (!this.messageHandlers) {
      this.messageHandlers = new MessageHandlers();
    }

    if (event.data && event.data.action && event.data.action !== 'init') {
      if (this.messageHandlers[event.data.action]) {
        this.messageHandlers[event.data.action](event.data);
      }
    }
  };
};

export default (self) => {
  return new Worker(self);
};
