// world_popup.js — World map blimp-driven artist select panel
// The blimp IS the cursor. No mouse interaction on the world map.
// When the blimp flies near a marker dot, a fixed HUD panel appears at the
// bottom of the screen showing the artist name + 3 feed images (city-select style).
// Left/Right cycle artists in a cluster. Enter navigates to nearest blimp port.

(function() {
'use strict';

var PANEL_THUMB = 96;
var PANEL_GAP   = 6;
var PANEL_PAD   = 14;
var PANEL_H     = PANEL_THUMB + 56;

var HOVER_RADIUS_SQ = 0;
var STICKY_TIME     = 1.5;
var _stickyTimer    = 0;

// ── Blimp proximity detection ─────────────────────────────────

function updateBlimpHover(dt) {
    if (game.mode !== 'WORLD' || game.state !== 'OVERWORLD') {
        _clearHover();
        return;
    }

    var ts = typeof TILE_SIZE !== 'undefined' ? TILE_SIZE : 8;
    HOVER_RADIUS_SQ = (4 * ts) * (4 * ts);

    var p  = game.player;
    var bx = p.x + p.width / 2;
    var by = p.y + p.height / 2;
    var worldPxW = typeof WORLD_WIDTH !== 'undefined' ? WORLD_WIDTH * ts : 99999;

    var bestDist = Infinity;
    var bestMarker = null;

    for (var i = 0; i < WORLD_MARKERS.length; i++) {
        var m = WORLD_MARKERS[i];
        var dx = bx - m.worldX;
        if (dx > worldPxW / 2) dx -= worldPxW;
        else if (dx < -worldPxW / 2) dx += worldPxW;
        var dy = by - m.worldY;
        var d2 = dx * dx + dy * dy;
        if (d2 < HOVER_RADIUS_SQ && d2 < bestDist) {
            bestDist = d2;
            bestMarker = m;
        }
    }

    if (bestMarker) {
        _stickyTimer = STICKY_TIME;
        if (bestMarker !== game.hoveredMarker) {
            game.hoveredMarker = bestMarker;
            game.hoveredArtistIdx = 0;
            _loadFeed(bestMarker.artists[0]);
        }
    } else {
        if (game.hoveredMarker) {
            _stickyTimer -= dt;
            if (_stickyTimer <= 0) {
                _clearHover();
            }
        }
    }
}

function _clearHover() {
    game.hoveredMarker = null;
    game.hoveredArtistIdx = 0;
    game.expandedCluster = null;
    _stickyTimer = 0;
}

// ── Feed loading + caching ────────────────────────────────────

function _loadFeed(artistId) {
    if (game.igFeedCache[artistId]) return;
    game.igFeedCache[artistId] = { items: [], loaded: false };
    fetch('data/ig/' + artistId + '.json')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var posts = data.items || data.posts || [];
            var items = posts.slice(0, 3);
            game.igFeedCache[artistId] = { items: items, loaded: true };
            for (var i = 0; i < items.length; i++) {
                var url = items[i].imageUrl;
                if (url && !game.igThumbCache[url]) {
                    var img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.src = url;
                    game.igThumbCache[url] = img;
                }
            }
        })
        .catch(function() {
            game.igFeedCache[artistId] = { items: [], loaded: true };
        });
}

// ── Fixed-position artist select panel (bottom center) ────────

function drawArtistPanel() {
    var marker = game.hoveredMarker;
    if (!marker) return;

    var artistId = marker.artists[game.hoveredArtistIdx] || marker.artists[0];
    var artist = ARTISTS[artistId];
    if (!artist) return;

    var feed = game.igFeedCache[artistId];
    var items = (feed && feed.loaded) ? feed.items : [];

    var cw = typeof CANVAS_WIDTH  !== 'undefined' ? CANVAS_WIDTH  : ctx.canvas.width;
    var ch = typeof CANVAS_HEIGHT !== 'undefined' ? CANVAS_HEIGHT : ctx.canvas.height;

    var totalImgW = 3 * PANEL_THUMB + 2 * PANEL_GAP;
    var panelW = totalImgW + 2 * PANEL_PAD + 60;
    var panelX = Math.floor((cw - panelW) / 2);
    var panelY = ch - PANEL_H - 10;

    ctx.save();

    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(panelX, panelY, panelW, PANEL_H);
    ctx.strokeStyle = '#fc00fc';
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX, panelY, panelW, PANEL_H);

    ctx.strokeStyle = 'rgba(252, 0, 252, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(panelX + 3, panelY + 3, panelW - 6, PANEL_H - 6);

    var nameText = (artist.name || artistId).toUpperCase();
    var cityText = '';
    if (artist.city) {
        cityText = artist.city;
        if (artist.country && artist.country !== 'USA') cityText += ', ' + artist.country;
    }

    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fc00fc';
    ctx.fillText(nameText, cw / 2, panelY + 8);

    if (cityText) {
        ctx.font = '10px monospace';
        ctx.fillStyle = '#aaa';
        ctx.fillText(cityText, cw / 2, panelY + 24);
    }

    var imgStartX = Math.floor((cw - totalImgW) / 2);
    var imgY = panelY + 38;

    for (var ti = 0; ti < 3; ti++) {
        var tx = imgStartX + ti * (PANEL_THUMB + PANEL_GAP);
        var item = items[ti];
        if (item && item.imageUrl && game.igThumbCache[item.imageUrl]) {
            var thumbImg = game.igThumbCache[item.imageUrl];
            if (thumbImg.complete && thumbImg.naturalWidth > 0) {
                ctx.drawImage(thumbImg, tx, imgY, PANEL_THUMB, PANEL_THUMB);
                ctx.strokeStyle = 'rgba(255,255,255,0.5)';
                ctx.lineWidth = 1;
                ctx.strokeRect(tx, imgY, PANEL_THUMB, PANEL_THUMB);
            } else {
                _drawPlaceholder(tx, imgY);
            }
        } else {
            _drawPlaceholder(tx, imgY);
        }
    }

    var hasMultiple = marker.artists.length > 1;
    if (hasMultiple) {
        var arrowY = imgY + PANEL_THUMB / 2;
        var arrowLX = imgStartX - 24;
        var arrowRX = imgStartX + totalImgW + 18;

        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.fillStyle = '#000';
        ctx.fillText('\u25C0', arrowLX + 1, arrowY + 1);
        ctx.fillStyle = '#fc00fc';
        ctx.fillText('\u25C0', arrowLX, arrowY);

        ctx.fillStyle = '#000';
        ctx.fillText('\u25B6', arrowRX + 1, arrowY + 1);
        ctx.fillStyle = '#fc00fc';
        ctx.fillText('\u25B6', arrowRX, arrowY);

        ctx.font = '9px monospace';
        ctx.fillStyle = '#888';
        ctx.fillText((game.hoveredArtistIdx + 1) + '/' + marker.artists.length, cw / 2, panelY + PANEL_H - 8);
    }

    if (feed && !feed.loaded) {
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#aaa';
        ctx.fillText('loading...', cw / 2, imgY + PANEL_THUMB / 2);
    }

    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#666';
    ctx.fillText('ENTER to visit', panelX + panelW - 8, panelY + PANEL_H - 4);

    ctx.restore();

    _highlightActiveMarker(marker);
}

function _drawPlaceholder(x, y) {
    ctx.fillStyle = 'rgba(40, 0, 40, 0.8)';
    ctx.fillRect(x, y, PANEL_THUMB, PANEL_THUMB);
    ctx.strokeStyle = 'rgba(252, 0, 252, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, PANEL_THUMB, PANEL_THUMB);
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#555';
    ctx.fillText('no image', x + PANEL_THUMB / 2, y + PANEL_THUMB / 2);
}

function _highlightActiveMarker(marker) {
    var sx = marker.worldX - game.camera.x;
    var ts = typeof TILE_SIZE !== 'undefined' ? TILE_SIZE : 8;
    var worldPxW = typeof WORLD_WIDTH !== 'undefined' ? WORLD_WIDTH * ts : 99999;
    if (sx > worldPxW / 2) sx -= worldPxW;
    else if (sx < -worldPxW / 2) sx += worldPxW;
    var sy = marker.worldY - game.camera.y;

    var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
    var radius = 8 + pulse * 4;

    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(252, 0, 252, ' + (0.4 + pulse * 0.4) + ')';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fc00fc';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
}

// ── Keyboard: cycle artists (Left/Right) ──────────────────────

function cycleArtist(dir) {
    var marker = game.hoveredMarker;
    if (!marker || marker.artists.length <= 1) return;
    game.hoveredArtistIdx = (game.hoveredArtistIdx + dir + marker.artists.length) % marker.artists.length;
    var aid = marker.artists[game.hoveredArtistIdx];
    _loadFeed(aid);
}

// ── Enter: navigate to artist's region via nearest blimp port ─

function enterHoveredArtist() {
    var marker = game.hoveredMarker;
    if (!marker) return false;

    var artistId = marker.artists[game.hoveredArtistIdx] || marker.artists[0];
    var artist = ARTISTS[artistId];
    if (!artist) return false;

    console.log('enterHoveredArtist: navigating to', artistId, 'region:', artist.regionId);
    game.pendingVisitArtist = artistId;
    game.hoveredMarker = null;
    game.expandedCluster = null;
    _stickyTimer = 0;
    startEnterRegion(artist.regionId || 'na');
    return true;
}

// ── Expose to global scope ────────────────────────────────────

window.updateBlimpHover   = updateBlimpHover;
window.drawArtistPanel    = drawArtistPanel;
window.cycleWorldArtist   = cycleArtist;
window.enterHoveredArtist = enterHoveredArtist;

// ── Monkey-patch drawWorldNodes to inject panel rendering ─────

var _origDrawWorldNodes = window.drawWorldNodes;
window.drawWorldNodes = function() {
    if (typeof _origDrawWorldNodes === 'function') _origDrawWorldNodes();
    if (typeof game === 'undefined' || game.mode !== 'WORLD') return;
    drawArtistPanel();
};

})();
