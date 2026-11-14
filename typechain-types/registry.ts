/* eslint-disable */
import '@solidcash/testing/hre';

declare module '@solidcash/testing/hre' {
  interface SolidcashArtifactMap {
    'AegisBCH': typeof import('../artifacts/solidcash/AegisBCH.artifact.js').default;
    'FoldingPool': typeof import('../artifacts/solidcash/FoldingPool.artifact.js').default;
  }
}

export {};
