function paintablepalette_getForegroundRGB() {
    try {
        var c = app.foregroundColor;
        var r = Math.round(c.rgb.red);
        var g = Math.round(c.rgb.green);
        var b = Math.round(c.rgb.blue);
        return '{"r":' + r + ',"g":' + g + ',"b":' + b + '}';
    } catch (e) {
        return '';
    }
}

function paintablepalette_setForegroundRGB(r, g, b) {
    var c = new SolidColor();
    c.rgb.red = r;
    c.rgb.green = g;
    c.rgb.blue = b;
    app.foregroundColor = c;
    return 'OK';
}

function paintablepalette_json_string(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function paintablepalette_exportCurrentSelection() {
    var source_doc = app.activeDocument;
    var temp_doc = null;
    var temp_file = null;
    try {
        if (!source_doc || !source_doc.activeLayer) throw new Error('No active document or layer.');

        // Accessing bounds raises an error when Photoshop has no active selection.
        var bounds = source_doc.selection.bounds;
        var selection_width = Math.max(1, Math.ceil(bounds[2].as('px') - bounds[0].as('px')));
        var selection_height = Math.max(1, Math.ceil(bounds[3].as('px') - bounds[1].as('px')));
        source_doc.selection.copy();

        temp_doc = app.documents.add(selection_width, selection_height, source_doc.resolution, 'PaintablePalette Export', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        temp_doc.paste();
        temp_doc.trim(TrimType.TRANSPARENT, true, true, true, true);
        if (temp_doc.width.as('px') < 1 || temp_doc.height.as('px') < 1) throw new Error('The selected area has no visible pixels on the active layer.');

        temp_file = new File(Folder.temp.fsName + '/paintablepalette-current-selection.png');
        if (temp_file.exists) temp_file.remove();
        var options = new PNGSaveOptions();
        temp_doc.saveAs(temp_file, options, true, Extension.LOWERCASE);
        temp_doc.close(SaveOptions.DONOTSAVECHANGES);
        temp_doc = null;
        app.activeDocument = source_doc;
        return '{"path":' + paintablepalette_json_string(temp_file.fsName) + '}';
    } catch (e) {
        if (temp_doc) {
            try { temp_doc.close(SaveOptions.DONOTSAVECHANGES); } catch (_) {}
        }
        try { app.activeDocument = source_doc; } catch (_) {}
        return '{"error":' + paintablepalette_json_string(e.message || e.toString()) + '}';
    }
}

