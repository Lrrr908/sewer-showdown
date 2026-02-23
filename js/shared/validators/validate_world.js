// js/shared/validators/validate_world.js
// Input: {version?, world, ...} or world object with nodes
// Returns: errors[] with stable WLD_* codes and JSON Pointer paths

if (typeof err === 'undefined' && typeof require !== 'undefined') {
    var _e = require('../errors'), SEVERITY = _e.SEVERITY, err = _e.err;
}

function validate_world(file) {
    var errors = [];
    if (!file || typeof file !== 'object') {
        errors.push(err('WLD_NOT_OBJECT', SEVERITY.error, '', 'world file must be an object'));
        return errors;
    }
    if (file.version != null && (typeof file.version !== 'number' || file.version !== Math.floor(file.version))) {
        errors.push(err('WLD_VERSION_INVALID', SEVERITY.error, '/version', 'version must be an integer'));
    }

    var nodes = file.nodes || file.world;
    var nodesPtr = file.nodes ? '/nodes' : '/world';
    if (!Array.isArray(nodes)) {
        errors.push(err('WLD_NODES_MISSING', SEVERITY.error, nodesPtr, 'world must have a nodes array'));
        return errors;
    }

    var seenIds = {};
    var positions = {};
    for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var ptr = nodesPtr + '/' + i;
        if (!n || typeof n !== 'object') {
            errors.push(err('WLD_NODE_NOT_OBJECT', SEVERITY.error, ptr, 'world node must be an object'));
            continue;
        }
        if (typeof n.id !== 'string' || n.id.length === 0) {
            errors.push(err('WLD_NODE_ID_MISSING', SEVERITY.error, ptr + '/id', 'node must have a non-empty string id'));
        } else {
            if (seenIds[n.id]) {
                errors.push(err('WLD_NODE_ID_DUPLICATE', SEVERITY.error, ptr + '/id', 'duplicate node id: ' + n.id));
            }
            seenIds[n.id] = true;
        }
        if (typeof n.x !== 'number' || typeof n.y !== 'number') {
            errors.push(err('WLD_NODE_POS_INVALID', SEVERITY.error, ptr, 'node must have numeric x and y'));
        } else {
            var posKey = n.x + ',' + n.y;
            if (positions[posKey]) {
                errors.push(err('WLD_NODE_POS_OVERLAP', SEVERITY.warn, ptr, 'overlapping position with node at ' + positions[posKey]));
            }
            positions[posKey] = ptr;
        }
        if (n.region && typeof n.region !== 'string') {
            errors.push(err('WLD_NODE_REGION_TYPE', SEVERITY.error, ptr + '/region', 'region must be a string'));
        }
    }
    return errors;
}

if (typeof module !== 'undefined') module.exports = { validate_world: validate_world };
