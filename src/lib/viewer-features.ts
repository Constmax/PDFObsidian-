import { Notice } from 'obsidian';

import { PDFPlusToolbar } from 'toolbar';
import { BibliographyManager } from 'bib';
import { SidebarView } from 'pdfjs-enums';
import { ViewerFeature } from './viewer-lifecycle';
import { textboxFeature } from './textbox/feature';


/** PDF++'s part of the toolbar: color palette, display options, zoom level input, ... */
const toolbarFeature: ViewerFeature = {
    name: 'toolbar',
    toolbar(scope, { plugin, child, toolbar }) {
        try {
            scope.addChild(new PDFPlusToolbar(plugin, toolbar, child));

            const viewerContainerEl = child.pdfViewer?.dom?.viewerContainerEl;
            if (plugin.settings.autoHidePDFSidebar && viewerContainerEl) {
                scope.registerDomEvent(viewerContainerEl, 'click', () => {
                    child.pdfViewer.pdfSidebar.switchView(SidebarView.NONE);
                });
            }
        } catch (e) {
            new Notice(`${plugin.manifest.name}: An error occurred while mounting the color palette to the toolbar.`);
            console.error(e);
        }
    },
};

/** Detects the bibliography of the document, for citation popovers. */
const bibFeature: ViewerFeature = {
    name: 'bibliography',
    document(scope, { plugin, child }) {
        child.bib = scope.addChild(new BibliographyManager(plugin, child));
    },
};

/** The features attached to every PDF viewer, in the order they are set up. */
export const viewerFeatures: ViewerFeature[] = [
    toolbarFeature,
    textboxFeature,
    bibFeature,
];
