import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rasterizePdf, renderCaptureDocument } from '../capture-pdf-render';
import { extractSupplierImportFile } from '../../utils/supplier-import-parser';

const { getDocument, invoke } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument,
  GlobalWorkerOptions: { workerSrc: 'pdf.worker.mjs' },
}));
vi.mock('../../../lib', () => ({ getBridge: () => ({ invoke }) }));
vi.mock('../capture-client', () => ({ MAX_CAPTURE_PAGES: 10, saveCaptureDraft: vi.fn() }));

function loadingTask(pdf: unknown) {
  const task = { promise: Promise.resolve(pdf), destroy: vi.fn().mockResolvedValue(undefined) };
  getDocument.mockReturnValueOnce(task);
  return task;
}

function pdfPage() {
  return {
    getViewport: vi.fn(() => ({ width: 1000, height: 2000 })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    getTextContent: vi.fn().mockResolvedValue({ items: [] }),
    cleanup: vi.fn(),
  };
}

function pdfFile(): File {
  return {
    name: 'invoice.pdf',
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    text: async () => '',
  } as File;
}

beforeEach(() => {
  getDocument.mockReset();
  invoke.mockReset();
});

describe('PDF resource lifetime', () => {
  it('releases each canvas and the document worker after rasterization', async () => {
    const page = pdfPage();
    const task = loadingTask({ numPages: 2, getPage: vi.fn().mockResolvedValue(page) });
    const canvases: HTMLCanvasElement[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      canvases.push(this as HTMLCanvasElement);
      return {} as CanvasRenderingContext2D;
    } as typeof HTMLCanvasElement.prototype.getContext);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,aW1hZ2U=');

    await expect(rasterizePdf(new Uint8Array([1]))).resolves.toEqual([
      { pageIndex: 0, mime: 'image/jpeg', data: 'aW1hZ2U=' },
      { pageIndex: 1, mime: 'image/jpeg', data: 'aW1hZ2U=' },
    ]);

    expect(canvases).toHaveLength(2);
    for (const canvas of canvases) expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it.each(['render', 'canvas'] as const)('releases the worker and canvas after %s failure', async (failure) => {
    const page = pdfPage();
    if (failure === 'render') page.render.mockImplementation(() => ({ promise: Promise.reject(new Error('render failed')) }));
    const task = loadingTask({ numPages: 1, getPage: vi.fn().mockResolvedValue(page) });
    let canvas: HTMLCanvasElement | undefined;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      canvas = this as HTMLCanvasElement;
      return failure === 'canvas' ? null : {} as CanvasRenderingContext2D;
    } as typeof HTMLCanvasElement.prototype.getContext);

    await expect(rasterizePdf(new Uint8Array([1]))).rejects.toThrow(
      failure === 'canvas' ? 'Canvas is unavailable' : 'render failed',
    );
    expect([canvas?.width, canvas?.height]).toEqual([0, 0]);
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it.each(['rasterize', 'extract', 'probe'] as const)('destroys the loading task when %s cannot open a PDF', async (operation) => {
    const error = new Error('invalid PDF');
    const task = { promise: Promise.reject(error), destroy: vi.fn().mockResolvedValue(undefined) };
    getDocument.mockReturnValueOnce(task);
    if (operation === 'probe') {
      invoke.mockResolvedValueOnce({ success: true, data: 'AQ==' });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await renderCaptureDocument('capture-1');
      expect(invoke).toHaveBeenLastCalledWith('capture_attach_rendered_pages', {
        captureId: 'capture-1', pages: [], failureReason: 'CAPTURE_UNREADABLE',
      });
    } else {
      await expect(operation === 'rasterize' ? rasterizePdf(new Uint8Array([1])) : extractSupplierImportFile(pdfFile()))
        .rejects.toThrow(error);
    }
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it.each([false, true])('releases the extraction worker (text failure: %s)', async (fail) => {
    const page = pdfPage();
    if (fail) page.getTextContent.mockRejectedValue(new Error('text failed'));
    const task = loadingTask({ numPages: 1, getPage: vi.fn().mockResolvedValue(page) });
    if (fail) {
      await expect(extractSupplierImportFile(pdfFile())).rejects.toThrow('text failed');
    } else {
      await expect(extractSupplierImportFile(pdfFile())).resolves.toEqual({ rows: [], supplier: null });
    }
    expect(task.destroy).toHaveBeenCalledOnce();
  });
});
