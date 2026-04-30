export {
  buildApplicationPackage,
  type BuildPackageInput,
  type BuildPackageOutput,
  type CategoryGroup,
  type DocumentInPackage,
  type FlatFields,
} from "./buildApplicationPackage.js";

import {
  buildApplicationPackage as build,
  type BuildPackageInput,
  type BuildPackageOutput,
} from "./buildApplicationPackage.js";

export function buildLenderPackage<T>(input: T): T {
  return input;
}

const packageBuilder = {
  build: (input: BuildPackageInput): Promise<BuildPackageOutput> => build(input),
};

export default packageBuilder;
