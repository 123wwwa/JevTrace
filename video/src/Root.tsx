import { Composition } from 'remotion';
import { JevTraceShort, type ShortProps } from './JevTraceShort';
import demo from './data/demo.json';
import metrics from './data/metrics.json';
import timeline from './timeline.json';

// Both data files come from scripts/capture-demo.mjs (a real JevTrace run and the benchmark reports), so a new
// benchmark is a re-capture and a re-render, not a code change. `--props` can override either for one render.
const defaultProps: ShortProps = { demo, metrics };

export const Root = () => (
  <Composition
    id="JevTraceShort"
    component={JevTraceShort}
    durationInFrames={timeline.duration}
    fps={timeline.fps}
    width={1080}
    height={1920}
    defaultProps={defaultProps}
  />
);
