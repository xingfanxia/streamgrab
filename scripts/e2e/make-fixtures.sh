#!/usr/bin/env bash
# Generates local media fixtures for the e2e test: a direct MP4, HLS (TS master, AES-128, fMP4 with
# a separate audio rendition) and DASH. Output goes to the directory given as $1.
set -euo pipefail
out="${1:?usage: make-fixtures.sh <output-dir>}"
rm -rf "$out"
mkdir -p "$out"/{hls,hls-aes,hls-fmp4,dash}
out="$(cd "$out" && pwd)"
src="$out/source.mp4"

ffmpeg -v error -y -f lavfi -i "testsrc2=size=640x360:rate=25:duration=12" \
  -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=12" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 -bf 2 \
  -c:a aac -b:a 96k -movflags +faststart "$src"

cp "$src" "$out/direct.mp4"

# HLS, MPEG-TS segments, two variants behind a master playlist.
ffmpeg -v error -y -i "$src" \
  -filter_complex "[0:v]split=2[v1][v2];[v2]scale=320:180[v2s]" \
  -map "[v1]" -map 0:a -map "[v2s]" -map 0:a \
  -c:v libx264 -preset veryfast -g 50 -keyint_min 50 -sc_threshold 0 -bf 2 -c:a aac -b:a 96k \
  -b:v:0 800k -b:v:1 200k \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename "$out/hls/v%v_%03d.ts" \
  -master_pl_name master.m3u8 -var_stream_map "v:0,a:0 v:1,a:1" "$out/hls/v%v.m3u8"

# HLS with AES-128 (key published in the playlist, i.e. not DRM).
openssl rand 16 > "$out/hls-aes/enc.key"
printf 'enc.key\n%s\n%s\n' "$out/hls-aes/enc.key" "$(openssl rand -hex 16)" > "$out/hls-aes/keyinfo"
ffmpeg -v error -y -i "$src" -c copy -f hls -hls_time 2 -hls_playlist_type vod \
  -hls_key_info_file "$out/hls-aes/keyinfo" -hls_segment_filename "$out/hls-aes/s_%03d.ts" \
  "$out/hls-aes/index.m3u8"
rm "$out/hls-aes/keyinfo"

# HLS with fMP4 segments and audio as a separate rendition.
ffmpeg -v error -y -i "$src" -map 0:v -map 0:a -c copy \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_segment_filename "$out/hls-fmp4/s%v_%03d.m4s" -hls_fmp4_init_filename "init%v.mp4" \
  -master_pl_name master.m3u8 -var_stream_map "a:0,agroup:aud,default:yes v:0,agroup:aud" \
  "$out/hls-fmp4/s%v.m3u8"

# DASH with separate audio and video adaptation sets.
(cd "$out/dash" && ffmpeg -v error -y -i "$src" -map 0:v -map 0:a -c copy \
  -f dash -seg_duration 2 -use_template 1 -use_timeline 1 manifest.mpd)

# HLS master that adds a WebVTT subtitle rendition to the TS variants above.
mkdir -p "$out/hls-subs"
printf 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:03.000\nfirst line\n\n00:00:05.000 --> 00:00:07.000\nspans the boundary\n' > "$out/hls-subs/en_000.vtt"
printf 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:05.000 --> 00:00:07.000\nspans the boundary\n\n00:00:08.000 --> 00:00:10.000\nlast line\n' > "$out/hls-subs/en_001.vtt"
printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\nen_000.vtt\n#EXTINF:6,\nen_001.vtt\n#EXT-X-ENDLIST\n' > "$out/hls-subs/en.m3u8"
printf '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=983616,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",SUBTITLES="subs"\n../hls/v0.m3u8\n' > "$out/hls-subs/master.m3u8"

echo "fixtures written to $out"
