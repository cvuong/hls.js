/*
 * MSE Media Controller
*/

import Demuxer from '../demux/demuxer';
import Event from '../events';
import {logger} from '../utils/logger';
import LevelHelper from '../helper/level-helper';
import {ErrorTypes, ErrorDetails} from '../errors';

const State = {
  ERROR : -2,
  STARTING : -1,
  IDLE : 0,
  LOADING : 1,
  WAITING_LEVEL : 2,
  PARSING : 3,
  PARSED : 4,
  APPENDING : 5,
  BUFFER_FLUSHING : 6
};

class MSEMediaController {

  constructor(hls) {
    this.config = hls.config;
    this.hls = hls;
    // Source Buffer listeners
    this.onsbue = this.onSBUpdateEnd.bind(this);
    this.onsbe  = this.onSBUpdateError.bind(this);
    // internal listeners
    this.onmediaatt0 = this.onMediaAttaching.bind(this);
    this.onmediadet0 = this.onMediaDetaching.bind(this);
    this.onmp = this.onManifestParsed.bind(this);
    this.onll = this.onLevelLoaded.bind(this);
    this.onfl = this.onFragLoaded.bind(this);
    this.onis = this.onInitSegment.bind(this);
    this.onfpg = this.onFragParsing.bind(this);
    this.onfp = this.onFragParsed.bind(this);
    this.onerr = this.onError.bind(this);
    this.ontick = this.tick.bind(this);
    hls.on(Event.MEDIA_ATTACHING, this.onmediaatt0);
    hls.on(Event.MEDIA_DETACHING, this.onmediadet0);
    hls.on(Event.MANIFEST_PARSED, this.onmp);
  }

  destroy() {
    this.stop();
    var hls = this.hls;
    hls.off(Event.MEDIA_ATTACHING, this.onmediaatt0);
    hls.off(Event.MEDIA_DETACHING, this.onmediadet0);
    hls.off(Event.MANIFEST_PARSED, this.onmp);
    this.state = State.IDLE;
  }

  startLoad() {
    if (this.levels && this.media) {
      this.startInternal();
      if (this.lastCurrentTime) {
        logger.log(`seeking @ ${this.lastCurrentTime}`);
        if (!this.lastPaused) {
          logger.log('resuming video');
          this.media.play();
        }
        this.state = State.IDLE;
      } else {
        this.lastCurrentTime = 0;
        this.state = State.STARTING;
      }
      this.nextLoadPosition = this.startPosition = this.lastCurrentTime;
      this.tick();
    } else {
      logger.warn('cannot start loading as either manifest not parsed or video not attached');
    }
  }

  startInternal() {
    var hls = this.hls;
    this.stop();
    this.demuxer = new Demuxer(hls);
    this.timer = setInterval(this.ontick, 100);
    this.level = -1;
    hls.on(Event.FRAG_LOADED, this.onfl);
    hls.on(Event.FRAG_PARSING_INIT_SEGMENT, this.onis);
    hls.on(Event.FRAG_PARSING_DATA, this.onfpg);
    hls.on(Event.FRAG_PARSED, this.onfp);
    hls.on(Event.ERROR, this.onerr);
    hls.on(Event.LEVEL_LOADED, this.onll);
  }

  stop() {
    this.mp4segments = [];
    this.flushRange = [];
    this.bufferRange = [];
    var frag = this.fragCurrent;
    if (frag) {
      if (frag.loader) {
        frag.loader.abort();
      }
      this.fragCurrent = null;
    }
    this.fragPrevious = null;
    if (this.sourceBuffer) {
      for(var type in this.sourceBuffer) {
        var sb = this.sourceBuffer[type];
        try {
          this.mediaSource.removeSourceBuffer(sb);
          sb.removeEventListener('updateend', this.onsbue);
          sb.removeEventListener('error', this.onsbe);
        } catch(err) {
        }
      }
      this.sourceBuffer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.demuxer) {
      this.demuxer.destroy();
      this.demuxer = null;
    }
    var hls = this.hls;
    hls.off(Event.FRAG_LOADED, this.onfl);
    hls.off(Event.FRAG_PARSED, this.onfp);
    hls.off(Event.FRAG_PARSING_DATA, this.onfpg);
    hls.off(Event.LEVEL_LOADED, this.onll);
    hls.off(Event.FRAG_PARSING_INIT_SEGMENT, this.onis);
    hls.off(Event.ERROR, this.onerr);
  }

  tick() {
    var pos, level, levelDetails, fragIdx, hls = this.hls;
    switch(this.state) {
      case State.ERROR:
        //don't do anything in error state to avoid breaking further ...
        break;
      case State.STARTING:
        // determine load level
        this.startLevel = hls.startLevel;
        if (this.startLevel === -1) {
          // -1 : guess start Level by doing a bitrate test by loading first fragment of lowest quality level
          this.startLevel = 0;
          this.fragBitrateTest = true;
        }
        // set new level to playlist loader : this will trigger start level load
        this.level = hls.nextLoadLevel = this.startLevel;
        this.state = State.WAITING_LEVEL;
        this.loadedmetadata = false;
        break;
      case State.IDLE:
        // if video detached or unbound exit loop
        if (!this.media) {
          break;
        }
        // determine next candidate fragment to be loaded, based on current position and
        //  end of buffer position
        //  ensure 60s of buffer upfront
        // if we have not yet loaded any fragment, start loading from start position
        if (this.loadedmetadata) {
          pos = this.media.currentTime;
        } else {
          pos = this.nextLoadPosition;
        }
        // determine next load level
        if (this.startFragmentRequested === false) {
          level = this.startLevel;
        } else {
          // we are not at playback start, get next load level from level Controller
          level = hls.nextLoadLevel;
        }
        var bufferInfo = this.bufferInfo(pos,0.3), bufferLen = bufferInfo.len, bufferEnd = bufferInfo.end, maxBufLen;
        // compute max Buffer Length that we could get from this load level, based on level bitrate. don't buffer more than 60 MB and more than 30s
        if ((this.levels[level]).hasOwnProperty('bitrate')) {
          maxBufLen = Math.max(8 * this.config.maxBufferSize / this.levels[level].bitrate, this.config.maxBufferLength);
          maxBufLen = Math.min(maxBufLen, this.config.maxMaxBufferLength);
        } else {
          maxBufLen = this.config.maxBufferLength;
        }
        // if buffer length is less than maxBufLen try to load a new fragment
        if (bufferLen < maxBufLen) {
          // set next load level : this will trigger a playlist load if needed
          hls.nextLoadLevel = level;
          this.level = level;
          levelDetails = this.levels[level].details;
          // if level info not retrieved yet, switch state and wait for level retrieval
          if (typeof levelDetails === 'undefined') {
            this.state = State.WAITING_LEVEL;
            break;
          }
          // find fragment index, contiguous with end of buffer position
          let fragments = levelDetails.fragments,
              fragLen = fragments.length,
              start = fragments[0].start,
              end = fragments[fragLen-1].start + fragments[fragLen-1].duration,
              frag;

            // in case of live playlist we need to ensure that requested position is not located before playlist start
          if (levelDetails.live) {
            // check if requested position is within seekable boundaries :
            //logger.log(`start/pos/bufEnd/seeking:${start.toFixed(3)}/${pos.toFixed(3)}/${bufferEnd.toFixed(3)}/${this.media.seeking}`);
            if (bufferEnd < Math.max(start,end-this.config.liveMaxLatencyDurationCount*levelDetails.targetduration)) {
                this.seekAfterBuffered = start + Math.max(0, levelDetails.totalduration - this.config.liveSyncDurationCount * levelDetails.targetduration);
                logger.log(`buffer end: ${bufferEnd} is located too far from the end of live sliding playlist, media position will be reseted to: ${this.seekAfterBuffered.toFixed(3)}`);
                bufferEnd = this.seekAfterBuffered;
            }
            if (this.startFragmentRequested && !levelDetails.PTSKnown) {
              /* we are switching level on live playlist, but we don't have any PTS info for that quality level ...
                 try to load frag matching with next SN.
                 even if SN are not synchronized between playlists, loading this frag will help us
                 compute playlist sliding and find the right one after in case it was not the right consecutive one */
              if (this.fragPrevious) {
                var targetSN = this.fragPrevious.sn + 1;
                if (targetSN >= levelDetails.startSN && targetSN <= levelDetails.endSN) {
                  frag = fragments[targetSN - levelDetails.startSN];
                  logger.log(`live playlist, switching playlist, load frag with next SN: ${frag.sn}`);
                }
              }
              if (!frag) {
                /* we have no idea about which fragment should be loaded.
                   so let's load mid fragment. it will help computing playlist sliding and find the right one
                */
                frag = fragments[Math.round(fragLen / 2)];
                logger.log(`live playlist, switching playlist, unknown, load middle frag : ${frag.sn}`);
              }
            }
          } else {
            // VoD playlist: if bufferEnd before start of playlist, load first fragment
            if (bufferEnd < start) {
              frag = fragments[0];
            }
          }
          if (!frag) {
            if (bufferEnd > end) {
              // reach end of playlist
              break;
            }
            for (fragIdx = 0; fragIdx < fragLen; fragIdx++) {
              frag = fragments[fragIdx];
              start = frag.start;
              //logger.log('level/sn/sliding/start/end/bufEnd:${level}/${frag.sn}/${sliding.toFixed(3)}/${start.toFixed(3)}/${(start+frag.duration).toFixed(3)}/${bufferEnd.toFixed(3)}');
              // offset should be within fragment boundary
              if (start <= bufferEnd && (start + frag.duration) > bufferEnd) {
                break;
              }
            }
            //logger.log('find SN matching with pos:' +  bufferEnd + ':' + frag.sn);
            if (this.fragPrevious && frag.level === this.fragPrevious.level && frag.sn === this.fragPrevious.sn) {
              if (fragIdx === (fragLen-1)) {
                // we are at the end of the playlist and we already loaded last fragment, don't do anything
                break;
              } else {
                frag = fragments[fragIdx + 1];
                logger.log(`SN just loaded, load next one: ${frag.sn}`);
              }
            }
          }
          logger.log(`Loading ${frag.sn} of [${levelDetails.startSN} ,${levelDetails.endSN}],level ${level}, currentTime:${pos},bufferEnd:${bufferEnd.toFixed(3)}`);
          //logger.log('      loading frag ' + i +',pos/bufEnd:' + pos.toFixed(3) + '/' + bufferEnd.toFixed(3));
          frag.autoLevel = hls.autoLevelEnabled;
          if (this.levels.length > 1) {
            frag.expectedLen = Math.round(frag.duration * this.levels[level].bitrate / 8);
            frag.trequest = new Date();
          }
          // ensure that we are not reloading the same fragments in loop ...
          if (this.fragLoadIdx !== undefined) {
            this.fragLoadIdx++;
          } else {
            this.fragLoadIdx = 0;
          }
          if (frag.loadCounter) {
            frag.loadCounter++;
            let maxThreshold = this.config.fragLoadingLoopThreshold;
            // if this frag has already been loaded 3 times, and if it has been reloaded recently
            if (frag.loadCounter > maxThreshold && (Math.abs(this.fragLoadIdx - frag.loadIdx) < maxThreshold)) {
              hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_LOOP_LOADING_ERROR, fatal: false, frag: frag});
              return;
            }
          } else {
            frag.loadCounter = 1;
          }
          frag.loadIdx = this.fragLoadIdx;
          this.fragCurrent = frag;
          this.startFragmentRequested = true;
          hls.trigger(Event.FRAG_LOADING, {frag: frag});
          this.state = State.LOADING;
        }
        break;
      case State.WAITING_LEVEL:
        level = this.levels[this.level];
        // check if playlist is already loaded
        if (level && level.details) {
          this.state = State.IDLE;
        }
        break;
      case State.LOADING:
        /*
          monitor fragment retrieval time...
          we compute expected time of arrival of the complete fragment.
          we compare it to expected time of buffer starvation
        */
        let v = this.media,frag = this.fragCurrent;
        /* only monitor frag retrieval time if
        (video not paused OR first fragment being loaded) AND autoswitching enabled AND not lowest level AND multiple levels */
        if (v && (!v.paused || this.loadedmetadata === false) && frag.autoLevel && this.level && this.levels.length > 1) {
          var requestDelay = new Date() - frag.trequest;
          // monitor fragment load progress after half of expected fragment duration,to stabilize bitrate
          if (requestDelay > (500 * frag.duration)) {
            var loadRate = frag.loaded * 1000 / requestDelay; // byte/s
            if (frag.expectedLen < frag.loaded) {
              frag.expectedLen = frag.loaded;
            }
            pos = v.currentTime;
            var fragLoadedDelay = (frag.expectedLen - frag.loaded) / loadRate;
            var bufferStarvationDelay = this.bufferInfo(pos,0.3).end - pos;
            var fragLevelNextLoadedDelay = frag.duration * this.levels[hls.nextLoadLevel].bitrate / (8 * loadRate); //bps/Bps
            /* if we have less than 2 frag duration in buffer and if frag loaded delay is greater than buffer starvation delay
              ... and also bigger than duration needed to load fragment at next level ...*/
            if (bufferStarvationDelay < (2 * frag.duration) && fragLoadedDelay > bufferStarvationDelay && fragLoadedDelay > fragLevelNextLoadedDelay) {
              // abort fragment loading ...
              logger.warn('loading too slow, abort fragment loading');
              logger.log(`fragLoadedDelay/bufferStarvationDelay/fragLevelNextLoadedDelay :${fragLoadedDelay.toFixed(1)}/${bufferStarvationDelay.toFixed(1)}/${fragLevelNextLoadedDelay.toFixed(1)}`);
              //abort fragment loading
              frag.loader.abort();
              hls.trigger(Event.FRAG_LOAD_EMERGENCY_ABORTED, {frag: frag});
              // switch back to IDLE state to request new fragment at lowest level
              this.state = State.IDLE;
            }
          }
        }
        break;
      case State.PARSING:
        // nothing to do, wait for fragment being parsed
        break;
      case State.PARSED:
      case State.APPENDING:
        if (this.sourceBuffer) {
          if (this.media.error) {
            logger.error('trying to append although a media error occured');
            hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_APPENDING_ERROR, frag: this.fragCurrent, fatal : true});
            this.state = State.ERROR;
            return;
          }
          // if MP4 segment appending in progress nothing to do
          else if ((this.sourceBuffer.audio && this.sourceBuffer.audio.updating) ||
             (this.sourceBuffer.video && this.sourceBuffer.video.updating)) {
            //logger.log('sb append in progress');
        // check if any MP4 segments left to append
          } else if (this.mp4segments.length) {
            var segment = this.mp4segments.shift();
            try {
              //logger.log(`appending ${segment.type} SB, size:${segment.data.length});
              this.sourceBuffer[segment.type].appendBuffer(segment.data);
              this.appendError = 0;
            } catch(err) {
              // in case any error occured while appending, put back segment in mp4segments table
              //logger.error(`error while trying to append buffer:${err.message},try appending later`);
              this.mp4segments.unshift(segment);
              if (this.appendError) {
                this.appendError++;
              } else {
                this.appendError = 1;
              }
              var event = {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_APPENDING_ERROR, frag: this.fragCurrent};
              /* with UHD content, we could get loop of quota exceeded error until
                browser is able to evict some data from sourcebuffer. retrying help recovering this
              */
              if (this.appendError > this.config.appendErrorMaxRetry) {
                logger.log(`fail ${this.config.appendErrorMaxRetry} times to append segment in sourceBuffer`);
                event.fatal = true;
                hls.trigger(Event.ERROR, event);
                this.state = State.ERROR;
                return;
              } else {
                event.fatal = false;
                hls.trigger(Event.ERROR, event);
              }
            }
            this.state = State.APPENDING;
          }
        } else {
          // sourceBuffer undefined, switch back to IDLE state
          this.state = State.IDLE;
        }
        break;
      case State.BUFFER_FLUSHING:
        // loop through all buffer ranges to flush
        while(this.flushRange.length) {
          var range = this.flushRange[0];
          // flushBuffer will abort any buffer append in progress and flush Audio/Video Buffer
          if (this.flushBuffer(range.start, range.end)) {
            // range flushed, remove from flush array
            this.flushRange.shift();
          } else {
            // flush in progress, come back later
            break;
          }
        }
        if (this.flushRange.length === 0) {
          // handle end of immediate switching if needed
          if (this.immediateSwitch) {
            this.immediateLevelSwitchEnd();
          }
          // move to IDLE once flush complete. this should trigger new fragment loading
          this.state = State.IDLE;
          // reset reference to frag
          this.fragPrevious = null;
        }
         /* if not everything flushed, stay in BUFFER_FLUSHING state. we will come back here
            each time sourceBuffer updateend() callback will be triggered
            */
        break;
      default:
        break;
    }
    // check/update current fragment
    this._checkFragmentChanged();
  }

   bufferInfo(pos,maxHoleDuration) {
    var v = this.media,
        buffered = v.buffered,
        bufferLen,
        // bufferStart and bufferEnd are buffer boundaries around current video position
        bufferStart, bufferEnd,bufferStartNext,
        i;
    var buffered2 = [];
    // there might be some small holes between buffer time range
    // consider that holes smaller than maxHoleDuration are irrelevant and build another
    // buffer time range representations that discards those holes
    for (i = 0; i < buffered.length; i++) {
      //logger.log('buf start/end:' + buffered.start(i) + '/' + buffered.end(i));
      if ((buffered2.length) && (buffered.start(i) - buffered2[buffered2.length - 1].end) < maxHoleDuration) {
        buffered2[buffered2.length - 1].end = buffered.end(i);
      } else {
        buffered2.push({start: buffered.start(i), end: buffered.end(i)});
      }
    }
    for (i = 0, bufferLen = 0, bufferStart = bufferEnd = pos; i < buffered2.length; i++) {
      var start =  buffered2[i].start,
          end = buffered2[i].end;
      //logger.log('buf start/end:' + buffered.start(i) + '/' + buffered.end(i));
      if ((pos + maxHoleDuration) >= start && pos < end) {
        // play position is inside this buffer TimeRange, retrieve end of buffer position and buffer length
        bufferStart = start;
        bufferEnd = end + maxHoleDuration;
        bufferLen = bufferEnd - pos;
      } else if ((pos + maxHoleDuration) < start) {
        bufferStartNext = start;
      }
    }
    return {len: bufferLen, start: bufferStart, end: bufferEnd, nextStart : bufferStartNext};
  }

  getBufferRange(position) {
    var i, range;
    for (i = this.bufferRange.length - 1; i >=0; i--) {
      range = this.bufferRange[i];
      if (position >= range.start && position <= range.end) {
        return range;
      }
    }
    return null;
  }

  get currentLevel() {
    if (this.media) {
      var range = this.getBufferRange(this.media.currentTime);
      if (range) {
        return range.frag.level;
      }
    }
    return -1;
  }

  get nextBufferRange() {
    if (this.media) {
      // first get end range of current fragment
      return this.followingBufferRange(this.getBufferRange(this.media.currentTime));
    } else {
      return null;
    }
  }

  followingBufferRange(range) {
    if (range) {
      // try to get range of next fragment (500ms after this range)
      return this.getBufferRange(range.end + 0.5);
    }
    return null;
  }

  get nextLevel() {
    var range = this.nextBufferRange;
    if (range) {
      return range.frag.level;
    } else {
      return -1;
    }
  }

  isBuffered(position) {
    var v = this.media, buffered = v.buffered;
    for (var i = 0; i < buffered.length; i++) {
      if (position >= buffered.start(i) && position <= buffered.end(i)) {
        return true;
      }
    }
    return false;
  }

  _checkFragmentChanged() {
    var rangeCurrent, currentTime, video = this.media;
    if (video && video.seeking === false) {
      currentTime = video.currentTime;
      /* if video element is in seeked state, currentTime can only increase.
        (assuming that playback rate is positive ...)
        As sometimes currentTime jumps back to zero after a
        media decode error, check this, to avoid seeking back to
        wrong position after a media decode error
      */
      if(currentTime > video.playbackRate*this.lastCurrentTime) {
        this.lastCurrentTime = currentTime;
      }
      if (this.isBuffered(currentTime)) {
        rangeCurrent = this.getBufferRange(currentTime);
      } else if (this.isBuffered(currentTime + 0.1)) {
        /* ensure that FRAG_CHANGED event is triggered at startup,
          when first video frame is displayed and playback is paused.
          add a tolerance of 100ms, in case current position is not buffered,
          check if current pos+100ms is buffered and use that buffer range
          for FRAG_CHANGED event reporting */
        rangeCurrent = this.getBufferRange(currentTime + 0.1);
      }
      if (rangeCurrent) {
        var fragPlaying = rangeCurrent.frag;
        if (fragPlaying !== this.fragPlaying) {
          this.fragPlaying = fragPlaying;
          this.hls.trigger(Event.FRAG_CHANGED, {frag: fragPlaying});
        }
        // if stream is VOD (not live) and we reach End of Stream
        var levelDetails = this.levels[this.level].details;
        if (levelDetails && !levelDetails.live) {
          // are we playing last fragment ?
          if (fragPlaying.sn === levelDetails.endSN) {
            var mediaSource = this.mediaSource;
            if (mediaSource && mediaSource.readyState === 'open') {
              logger.log('all media data available, signal endOfStream() to MediaSource');
              //Notify the media element that it now has all of the media data
              mediaSource.endOfStream();
            }
          }
        }
      }
    }
  }

  /*
    abort any buffer append in progress, and flush all buffered data
    return true once everything has been flushed.
    sourceBuffer.abort() and sourceBuffer.remove() are asynchronous operations
    the idea is to call this function from tick() timer and call it again until all resources have been cleaned
    the timer is rearmed upon sourceBuffer updateend() event, so this should be optimal
  */
  flushBuffer(startOffset, endOffset) {
    var sb, i, bufStart, bufEnd, flushStart, flushEnd;
    //logger.log('flushBuffer,pos/start/end: ' + this.media.currentTime + '/' + startOffset + '/' + endOffset);
    // safeguard to avoid infinite looping
    if (this.flushBufferCounter++ < (2 * this.bufferRange.length) && this.sourceBuffer) {
      for (var type in this.sourceBuffer) {
        sb = this.sourceBuffer[type];
        if (!sb.updating) {
          for (i = 0; i < sb.buffered.length; i++) {
            bufStart = sb.buffered.start(i);
            bufEnd = sb.buffered.end(i);
            // workaround firefox not able to properly flush multiple buffered range.
            if (navigator.userAgent.toLowerCase().indexOf('firefox') !== -1 && endOffset === Number.POSITIVE_INFINITY) {
              flushStart = startOffset;
              flushEnd = endOffset;
            } else {
              flushStart = Math.max(bufStart, startOffset);
              flushEnd = Math.min(bufEnd, endOffset);
            }
            /* sometimes sourcebuffer.remove() does not flush
               the exact expected time range.
               to avoid rounding issues/infinite loop,
               only flush buffer range of length greater than 500ms.
            */
            if (flushEnd - flushStart > 0.5) {
              logger.log(`flush ${type} [${flushStart},${flushEnd}], of [${bufStart},${bufEnd}], pos:${this.media.currentTime}`);
              sb.remove(flushStart, flushEnd);
              return false;
            }
          }
        } else {
          //logger.log('abort ' + type + ' append in progress');
          // this will abort any appending in progress
          //sb.abort();
          return false;
        }
      }
    }

    /* after successful buffer flushing, rebuild buffer Range array
      loop through existing buffer range and check if
      corresponding range is still buffered. only push to new array already buffered range
    */
    var newRange = [],range;
    for (i = 0; i < this.bufferRange.length; i++) {
      range = this.bufferRange[i];
      if (this.isBuffered((range.start + range.end) / 2)) {
        newRange.push(range);
      }
    }
    this.bufferRange = newRange;
    logger.log('buffer flushed');
    // everything flushed !
    return true;
  }

  /*
    on immediate level switch :
     - pause playback if playing
     - cancel any pending load request
     - and trigger a buffer flush
  */
  immediateLevelSwitch() {
    logger.log('immediateLevelSwitch');
    if (!this.immediateSwitch) {
      this.immediateSwitch = true;
      this.previouslyPaused = this.media.paused;
      this.media.pause();
    }
    var fragCurrent = this.fragCurrent;
    if (fragCurrent && fragCurrent.loader) {
      fragCurrent.loader.abort();
    }
    this.fragCurrent = null;
    // flush everything
    this.flushBufferCounter = 0;
    this.flushRange.push({start: 0, end: Number.POSITIVE_INFINITY});
    // trigger a sourceBuffer flush
    this.state = State.BUFFER_FLUSHING;
    // increase fragment load Index to avoid frag loop loading error after buffer flush
    this.fragLoadIdx += 2 * this.config.fragLoadingLoopThreshold;
    // speed up switching, trigger timer function
    this.tick();
  }

  /*
     on immediate level switch end, after new fragment has been buffered :
      - nudge video decoder by slightly adjusting video currentTime
      - resume the playback if needed
  */
  immediateLevelSwitchEnd() {
    this.immediateSwitch = false;
    this.media.currentTime -= 0.0001;
    if (!this.previouslyPaused) {
      this.media.play();
    }
  }

  nextLevelSwitch() {
    /* try to switch ASAP without breaking video playback :
       in order to ensure smooth but quick level switching,
      we need to find the next flushable buffer range
      we should take into account new segment fetch time
    */
    var fetchdelay, currentRange, nextRange;
    currentRange = this.getBufferRange(this.media.currentTime);
    if (currentRange) {
    // flush buffer preceding current fragment (flush until current fragment start offset)
    // minus 1s to avoid video freezing, that could happen if we flush keyframe of current video ...
      this.flushRange.push({start: 0, end: currentRange.start - 1});
    }
    if (!this.media.paused) {
      // add a safety delay of 1s
      var nextLevelId = this.hls.nextLoadLevel,nextLevel = this.levels[nextLevelId], fragLastKbps = this.fragLastKbps;
      if (fragLastKbps && this.fragCurrent) {
        fetchdelay = this.fragCurrent.duration * nextLevel.bitrate / (1000 * fragLastKbps) + 1;
      } else {
        fetchdelay = 0;
      }
    } else {
      fetchdelay = 0;
    }
    //logger.log('fetchdelay:'+fetchdelay);
    // find buffer range that will be reached once new fragment will be fetched
    nextRange = this.getBufferRange(this.media.currentTime + fetchdelay);
    if (nextRange) {
      // we can flush buffer range following this one without stalling playback
      nextRange = this.followingBufferRange(nextRange);
      if (nextRange) {
        // flush position is the start position of this new buffer
        this.flushRange.push({start: nextRange.start, end: Number.POSITIVE_INFINITY});
        // if we are here, we can also cancel any loading/demuxing in progress, as they are useless
        var fragCurrent = this.fragCurrent;
        if (fragCurrent && fragCurrent.loader) {
          fragCurrent.loader.abort();
        }
        this.fragCurrent = null;
      }
    }
    if (this.flushRange.length) {
      this.flushBufferCounter = 0;
      // trigger a sourceBuffer flush
      this.state = State.BUFFER_FLUSHING;
      // increase fragment load Index to avoid frag loop loading error after buffer flush
      this.fragLoadIdx += 2 * this.config.fragLoadingLoopThreshold;
      // speed up switching, trigger timer function
      this.tick();
    }
  }

  onMediaAttaching(event, data) {
    var media = this.media = data.media;
    // setup the media source
    var ms = this.mediaSource = new MediaSource();
    //Media Source listeners
    this.onmso = this.onMediaSourceOpen.bind(this);
    this.onmse = this.onMediaSourceEnded.bind(this);
    this.onmsc = this.onMediaSourceClose.bind(this);
    ms.addEventListener('sourceopen', this.onmso);
    ms.addEventListener('sourceended', this.onmse);
    ms.addEventListener('sourceclose', this.onmsc);
    // link video and media Source
    media.src = URL.createObjectURL(ms);
    // FIXME: this was in code before but onverror was never set! can be removed or fixed?
    //media.addEventListener('error', this.onverror);
  }

  onMediaDetaching() {
    var media = this.media;
    if (media && media.ended) {
      logger.log('MSE detaching and video ended, reset startPosition');
      this.startPosition = this.lastCurrentTime = 0;
    }

    // reset fragment loading counter on MSE detaching to avoid reporting FRAG_LOOP_LOADING_ERROR after error recovery
    var levels = this.levels;
    if (levels) {
      // reset fragment load counter
        levels.forEach(level => {
          if(level.details) {
            level.details.fragments.forEach(fragment => {
              fragment.loadCounter = undefined;
            });
          }
      });
    }
    var ms = this.mediaSource;
    if (ms) {
      if (ms.readyState === 'open') {
        ms.endOfStream();
      }
      ms.removeEventListener('sourceopen', this.onmso);
      ms.removeEventListener('sourceended', this.onmse);
      ms.removeEventListener('sourceclose', this.onmsc);
      // unlink MediaSource from video tag
      this.media.src = '';
      this.mediaSource = null;
      // remove video listeners
      if (media) {
        media.removeEventListener('seeking', this.onvseeking);
        media.removeEventListener('seeked', this.onvseeked);
        media.removeEventListener('loadedmetadata', this.onvmetadata);
        media.removeEventListener('ended', this.onvended);
        this.onvseeking = this.onvseeked = this.onvmetadata = null;
      }
      this.media = null;
      this.loadedmetadata = false;
      this.stop();
    }
    this.onmso = this.onmse = this.onmsc = null;
    this.hls.trigger(Event.MEDIA_DETACHED);
  }

  onMediaSeeking() {
    if (this.state === State.LOADING) {
      // check if currently loaded fragment is inside buffer.
      //if outside, cancel fragment loading, otherwise do nothing
      if (this.bufferInfo(this.media.currentTime,0.3).len === 0) {
        logger.log('seeking outside of buffer while fragment load in progress, cancel fragment load');
        var fragCurrent = this.fragCurrent;
        if (fragCurrent) {
          if (fragCurrent.loader) {
            fragCurrent.loader.abort();
          }
          this.fragCurrent = null;
        }
        this.fragPrevious = null;
        // switch to IDLE state to load new fragment
        this.state = State.IDLE;
      }
    }
    if (this.media) {
      this.lastCurrentTime = this.media.currentTime;
    }
    // avoid reporting fragment loop loading error in case user is seeking several times on same position
    if (this.fragLoadIdx !== undefined) {
      this.fragLoadIdx += 2 * this.config.fragLoadingLoopThreshold;
    }
    // tick to speed up processing
    this.tick();
  }

  onMediaSeeked() {
    // tick to speed up FRAGMENT_PLAYING triggering
    this.tick();
  }

  onMediaMetadata() {
    if (this.media.currentTime !== this.startPosition) {
      this.media.currentTime = this.startPosition;
    }
    this.loadedmetadata = true;
    this.tick();
  }

  onMediaEnded() {
    logger.log('video ended');
    // reset startPosition and lastCurrentTime to restart playback @ stream beginning
    this.startPosition = this.lastCurrentTime = 0;
  }


  onManifestParsed(event, data) {
    var aac = false, heaac = false, codecs;
    data.levels.forEach(level => {
      // detect if we have different kind of audio codecs used amongst playlists
      codecs = level.codecs;
      if (codecs) {
        if (codecs.indexOf('mp4a.40.2') !== -1) {
          aac = true;
        }
        if (codecs.indexOf('mp4a.40.5') !== -1) {
          heaac = true;
        }
      }
    });
    this.audiocodecswitch = (aac && heaac);
    if (this.audiocodecswitch) {
      logger.log('both AAC/HE-AAC audio found in levels; declaring audio codec as HE-AAC');
    }
    this.levels = data.levels;
    this.startLevelLoaded = false;
    this.startFragmentRequested = false;
    if (this.media && this.config.autoStartLoad) {
      this.startLoad();
    }
  }

  onLevelLoaded(event,data) {
    var newDetails = data.details,
        newLevelId = data.level,
        curLevel = this.levels[newLevelId],
        duration = newDetails.totalduration;

    logger.log(`level ${newLevelId} loaded [${newDetails.startSN},${newDetails.endSN}],duration:${duration}`);

    if (newDetails.live) {
      var curDetails = curLevel.details;
      if (curDetails) {
        // we already have details for that level, merge them
        LevelHelper.mergeDetails(curDetails,newDetails);
        if (newDetails.PTSKnown) {
          logger.log(`live playlist sliding:${newDetails.fragments[0].start.toFixed(3)}`);
        } else {
          logger.log('live playlist - outdated PTS, unknown sliding');
        }
      } else {
        newDetails.PTSKnown = false;
        logger.log('live playlist - first load, unknown sliding');
      }
    } else {
      newDetails.PTSKnown = false;
    }
    // override level info
    curLevel.details = newDetails;
    this.hls.trigger(Event.LEVEL_UPDATED, { details: newDetails, level: newLevelId });

    // compute start position
    if (this.startLevelLoaded === false) {
      // if live playlist, set start position to be fragment N-this.config.liveSyncDurationCount (usually 3)
      if (newDetails.live) {
        this.startPosition = Math.max(0, duration - this.config.liveSyncDurationCount * newDetails.targetduration);
      }
      this.nextLoadPosition = this.startPosition;
      this.startLevelLoaded = true;
    }
    // only switch batck to IDLE state if we were waiting for level to start downloading a new fragment
    if (this.state === State.WAITING_LEVEL) {
      this.state = State.IDLE;
    }
    //trigger handler right now
    this.tick();
  }

  onFragLoaded(event, data) {
    var fragCurrent = this.fragCurrent;
    if (this.state === State.LOADING &&
        fragCurrent &&
        data.frag.level === fragCurrent.level &&
        data.frag.sn === fragCurrent.sn) {
      if (this.fragBitrateTest === true) {
        // switch back to IDLE state ... we just loaded a fragment to determine adequate start bitrate and initialize autoswitch algo
        this.state = State.IDLE;
        this.fragBitrateTest = false;
        data.stats.tparsed = data.stats.tbuffered = new Date();
        this.hls.trigger(Event.FRAG_BUFFERED, {stats: data.stats, frag: fragCurrent});
      } else {
        this.state = State.PARSING;
        // transmux the MPEG-TS data to ISO-BMFF segments
        this.stats = data.stats;
        var currentLevel = this.levels[this.level],
            details = currentLevel.details,
            duration = details.totalduration,
            start = fragCurrent.start,
            level = fragCurrent.level,
            sn = fragCurrent.sn;
        logger.log(`Demuxing ${sn} of [${details.startSN} ,${details.endSN}],level ${level}`);
        this.demuxer.push(data.payload, currentLevel.audioCodec, currentLevel.videoCodec, start, fragCurrent.cc, level, duration);
      }
    }
  }

  onInitSegment(event, data) {
    if (this.state === State.PARSING) {
      // check if codecs have been explicitely defined in the master playlist for this level;
      // if yes use these ones instead of the ones parsed from the demux
      var audioCodec = this.levels[this.level].audioCodec, videoCodec = this.levels[this.level].videoCodec, sb;
      //logger.log('playlist level A/V codecs:' + audioCodec + ',' + videoCodec);
      //logger.log('playlist codecs:' + codec);
      // if playlist does not specify codecs, use codecs found while parsing fragment
      if (audioCodec === undefined || data.audiocodec === undefined) {
        audioCodec = data.audioCodec;
      }
      if (videoCodec === undefined || data.videocodec === undefined) {
        videoCodec = data.videoCodec;
      }
      // in case several audio codecs might be used, force HE-AAC for audio (some browsers don't support audio codec switch)
      //don't do it for mono streams ...
      var ua = navigator.userAgent.toLowerCase();
      if (this.audiocodecswitch &&
         data.audioChannelCount !== 1 &&
          ua.indexOf('android') === -1 &&
          ua.indexOf('firefox') === -1) {
        audioCodec = 'mp4a.40.5';
      }
      if (!this.sourceBuffer) {
        this.sourceBuffer = {};
        logger.log(`selected A/V codecs for sourceBuffers:${audioCodec},${videoCodec}`);
        // create source Buffer and link them to MediaSource
        if (audioCodec) {
          sb = this.sourceBuffer.audio = this.mediaSource.addSourceBuffer(`video/mp4;codecs=${audioCodec}`);
          sb.addEventListener('updateend', this.onsbue);
          sb.addEventListener('error', this.onsbe);
        }
        if (videoCodec) {
          sb = this.sourceBuffer.video = this.mediaSource.addSourceBuffer(`video/mp4;codecs=${videoCodec}`);
          sb.addEventListener('updateend', this.onsbue);
          sb.addEventListener('error', this.onsbe);
        }
      }
      if (audioCodec) {
        this.mp4segments.push({type: 'audio', data: data.audioMoov});
      }
      if(videoCodec) {
        this.mp4segments.push({type: 'video', data: data.videoMoov});
      }
      //trigger handler right now
      this.tick();
    }
  }

  onFragParsing(event, data) {
    if (this.state === State.PARSING) {
      this.tparse2 = Date.now();
      var level = this.levels[this.level],
          frag = this.fragCurrent;
      logger.log(`parsed data, type/startPTS/endPTS/startDTS/endDTS/nb:${data.type}/${data.startPTS.toFixed(3)}/${data.endPTS.toFixed(3)}/${data.startDTS.toFixed(3)}/${data.endDTS.toFixed(3)}/${data.nb}`);
      var drift = LevelHelper.updateFragPTS(level.details,frag.sn,data.startPTS,data.endPTS);
      this.hls.trigger(Event.LEVEL_PTS_UPDATED, {details: level.details, level: this.level, drift: drift});

      this.mp4segments.push({type: data.type, data: data.moof});
      this.mp4segments.push({type: data.type, data: data.mdat});
      this.nextLoadPosition = data.endPTS;
      this.bufferRange.push({type: data.type, start: data.startPTS, end: data.endPTS, frag: frag});

      //trigger handler right now
      this.tick();
    } else {
      logger.warn(`not in PARSING state, discarding ${event}`);
    }
  }

  onFragParsed() {
    if (this.state === State.PARSING) {
      this.state = State.PARSED;
      this.stats.tparsed = new Date();
      //trigger handler right now
      this.tick();
    }
  }

  onError(event, data) {
    switch(data.details) {
      // abort fragment loading on errors
      case ErrorDetails.FRAG_LOAD_ERROR:
      case ErrorDetails.FRAG_LOAD_TIMEOUT:
      case ErrorDetails.FRAG_LOOP_LOADING_ERROR:
      case ErrorDetails.LEVEL_LOAD_ERROR:
      case ErrorDetails.LEVEL_LOAD_TIMEOUT:
        // if fatal error, stop processing, otherwise move to IDLE to retry loading
        logger.warn(`buffer controller: ${data.details} while loading frag,switch to ${data.fatal ? 'ERROR' : 'IDLE'} state ...`);
        this.state = data.fatal ? State.ERROR : State.IDLE;
        break;
      default:
        break;
    }
  }

  onSBUpdateEnd() {
    //trigger handler right now
    if (this.state === State.APPENDING && this.mp4segments.length === 0)  {
      var frag = this.fragCurrent, stats = this.stats;
      if (frag) {
        this.fragPrevious = frag;
        stats.tbuffered = new Date();
        this.fragLastKbps = Math.round(8 * stats.length / (stats.tbuffered - stats.tfirst));
        this.hls.trigger(Event.FRAG_BUFFERED, {stats: stats, frag: frag});
        logger.log(`media buffered : ${this.timeRangesToString(this.media.buffered)}`);
        this.state = State.IDLE;
      }
      var video = this.media;
      if(video) {
        // seek back to a expected position after video buffered if needed
        if (this.seekAfterBuffered) {
          video.currentTime = this.seekAfterBuffered;
        } else {
          var currentTime = video.currentTime;
          var bufferInfo = this.bufferInfo(currentTime,0);
          // check if current time is buffered or not
          if(bufferInfo.len === 0) {
            // no buffer available @ currentTime, check if next buffer is close (in a 300 ms range)
            var nextBufferStart = bufferInfo.nextStart;
            if(nextBufferStart && (nextBufferStart - currentTime < 0.3)) {
              // next buffer is close ! adjust currentTime to nextBufferStart
              // this will ensure effective video decoding
              logger.log(`adjust currentTime from ${currentTime} to ${nextBufferStart}`);
              video.currentTime = nextBufferStart;
            }
          }
        }
      }
      // reset this variable, whether it was set or not
      this.seekAfterBuffered = undefined;
    }
    this.tick();
  }

  onSBUpdateError(event) {
    logger.error(`sourceBuffer error:${event}`);
    this.state = State.ERROR;
    this.hls.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_APPENDING_ERROR, fatal: true, frag: this.fragCurrent});
  }

  timeRangesToString(r) {
    var log = '', len = r.length;
    for (var i=0; i<len; i++) {
      log += '[' + r.start(i) + ',' + r.end(i) + ']';
    }
    return log;
  }

  onMediaSourceOpen() {
    logger.log('media source opened');
    this.hls.trigger(Event.MEDIA_ATTACHED);
    this.onvseeking = this.onMediaSeeking.bind(this);
    this.onvseeked = this.onMediaSeeked.bind(this);
    this.onvmetadata = this.onMediaMetadata.bind(this);
    this.onvended = this.onMediaEnded.bind(this);
    this.media.addEventListener('seeking', this.onvseeking);
    this.media.addEventListener('seeked', this.onvseeked);
    this.media.addEventListener('loadedmetadata', this.onvmetadata);
    this.media.addEventListener('ended', this.onvended);
    if(this.levels && this.config.autoStartLoad) {
      this.startLoad();
    }
    // once received, don't listen anymore to sourceopen event
    this.mediaSource.removeEventListener('sourceopen', this.onmso);
  }

  onMediaSourceClose() {
    logger.log('media source closed');
  }

  onMediaSourceEnded() {
    logger.log('media source ended');
  }
}
export default MSEMediaController;

