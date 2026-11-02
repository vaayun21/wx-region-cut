// Model choice for the India-wide network skill table, re-exported from shared standalone module.
export {
  MIN_PROVEN_PAIRS,
  BOOTSTRAP_ITERS,
  MIN_BOOTSTRAP_SAMPLES,
  HELD_OUT_TRAIN_SHARE,
  scopeAll,
  regionScope,
  stationScope,
  emptyNetworkSkill,
  foldPairIntoSkill,
  modelRanking,
  bootstrapDifferenceSd,
  chooseModel,
  worseFirstBands,
  evaluateHeldOut,
} from '../src/lib/standalone/wxModelChoice.ts'
