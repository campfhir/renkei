import { estimateOcrRemaining, MIN_SAMPLES, type OcrSample } from './artifact-ocr-estimate';

const MB = 1_048_576;

describe('estimateOcrRemaining', () => {
  it('gives no estimate until there are enough finished runs', () => {
    const samples: OcrSample[] = Array.from({ length: MIN_SAMPLES - 1 }, () => ({
      sizeBytes: MB,
      millis: 4000,
    }));
    expect(estimateOcrRemaining(samples, MB, 1000)).toEqual({
      remainingMs: null,
      overdue: false,
      totalMs: null,
      basedOn: MIN_SAMPLES - 1,
    });
  });

  it('takes the median of similar-size runs and subtracts what has elapsed', () => {
    const samples: OcrSample[] = [
      { sizeBytes: MB, millis: 3000 },
      { sizeBytes: 1.5 * MB, millis: 5000 },
      { sizeBytes: 2 * MB, millis: 4000 },
      { sizeBytes: 20 * MB, millis: 90000 },
    ];
    const estimate = estimateOcrRemaining(samples, 1.2 * MB, 1000);
    expect(estimate.totalMs).toBe(4000);
    expect(estimate.remainingMs).toBe(3000);
    expect(estimate.basedOn).toBe(3);
    expect(estimate.overdue).toBe(false);
  });

  it('scales the median time per byte when no similar-size runs are there', () => {
    const samples: OcrSample[] = [
      { sizeBytes: MB, millis: 2000 },
      { sizeBytes: MB, millis: 2000 },
      { sizeBytes: MB, millis: 2000 },
    ];
    const estimate = estimateOcrRemaining(samples, 10 * MB, 0);
    expect(estimate.totalMs).toBe(20000);
    expect(estimate.remainingMs).toBe(20000);
    expect(estimate.basedOn).toBe(3);
  });

  it('reports overdue, with no time left, once the run has passed its estimate', () => {
    const samples: OcrSample[] = Array.from({ length: 3 }, () => ({ sizeBytes: MB, millis: 2000 }));
    expect(estimateOcrRemaining(samples, MB, 5000)).toEqual({
      remainingMs: null,
      overdue: true,
      totalMs: 2000,
      basedOn: 3,
    });
  });
});
