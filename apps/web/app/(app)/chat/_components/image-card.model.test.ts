import {
  formatDuration,
  imageCardReducer,
  imageCardView,
  initImageCard,
  type ImageCardAction,
  type ImageCardState,
} from './image-card.model';

const view = (state: ImageCardState, over: Partial<Parameters<typeof imageCardView>[0]> = {}) =>
  imageCardView({
    state,
    animated: false,
    hasImage: state === 'done',
    resultContent: null,
    local: initImageCard(),
    ...over,
  });

const after = (...actions: ImageCardAction[]) => actions.reduce(imageCardReducer, initImageCard());

describe('the picture card, call by call', () => {
  it('waiting for permission is just its caption: nothing is drawn yet, so no outline', () => {
    expect(view('waiting')).toMatchObject({
      label: 'Waiting for permission to generate an image',
      body: 'none',
      showImage: false,
    });
  });

  it('being drawn is an outline with the caption saying so', () => {
    expect(view('pending')).toMatchObject({
      label: 'Generating image',
      body: 'frame',
      showImage: false,
      showPicture: false,
    });
  });

  it('done puts the picture in the outline, and fits the frame to it once drawn', () => {
    expect(view('done')).toMatchObject({
      label: 'Generated image',
      body: 'frame',
      showImage: true,
      showPicture: false,
    });
    expect(view('done', { local: after({ type: 'loaded' }) })).toMatchObject({
      showImage: true,
      showPicture: true,
      brokenNotice: false,
      missingNotice: false,
    });
  });

  it('a refused call says why, with no picture', () => {
    expect(
      view('failed', { resultContent: "The image model's safety system refused this request." })
    ).toMatchObject({
      label: 'Image could not be generated',
      body: 'error',
      errorText: "The image model's safety system refused this request.",
      showImage: false,
    });
  });

  it('a failure with no reason still says something', () => {
    expect(view('failed', { resultContent: '' }).errorText).toBe('The image tool failed.');
  });
});

describe('an animation', () => {
  it('is worded as one from waiting to done', () => {
    const animated = { animated: true };
    expect(view('waiting', animated).label).toBe('Waiting for permission to generate an animation');
    expect(view('pending', animated).label).toBe('Generating animation');
    expect(view('done', animated).label).toBe('Generated animation');
    expect(view('failed', animated).label).toBe('Animation could not be generated');
    expect(view('done', animated).noun).toBe('animation');
    expect(view('done').noun).toBe('image');
  });
});

describe('when the picture cannot be shown', () => {
  it('a picture the browser cannot draw is taken out and points to the Artifacts', () => {
    expect(view('done', { local: after({ type: 'broken' }) })).toMatchObject({
      showImage: false,
      showPicture: false,
      brokenNotice: true,
    });
  });

  it('a call done with no stored file says where to look instead', () => {
    expect(view('done', { hasImage: false })).toMatchObject({
      showImage: false,
      missingNotice: true,
    });
  });

  it('neither notice shows before the call is done', () => {
    expect(view('pending', { hasImage: false, local: after({ type: 'broken' }) })).toMatchObject({
      brokenNotice: false,
      missingNotice: false,
    });
  });
});

describe('the preview window', () => {
  it('opens on a press of the picture and closes again', () => {
    expect(after({ type: 'opened' }).open).toBe(true);
    expect(after({ type: 'opened' }, { type: 'closed' }).open).toBe(false);
  });

  it('a load reported twice changes nothing', () => {
    const once = after({ type: 'loaded' });
    expect(imageCardReducer(once, { type: 'loaded' })).toBe(once);
  });
});

describe("the call's time", () => {
  it('is in seconds under a minute, minutes and seconds after', () => {
    expect(formatDuration(400)).toBe('0s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(65_000)).toBe('1m 5s');
  });
});
