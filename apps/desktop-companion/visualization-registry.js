export const visualizations = [
  {
    id: "buzz",
    name: "BUZZ",
    theme: "buzz",
    load: () => import("./buzz.js").then((module) => module.buzzVisualization),
  },
  {
    id: "terminus",
    name: "Terminus",
    theme: "terminus",
    load: () => import("./terminus.js").then((module) => module.terminusVisualization),
  },
  {
    id: "ribbed-sphere-dark",
    name: "Dark sphere",
    theme: "dark",
    load: () => import("./ribbed-sphere.js").then((module) => module.darkRibbedSphereVisualization),
  },
  {
    id: "ribbed-sphere-light",
    name: "Light sphere",
    theme: "light",
    load: () => import("./ribbed-sphere.js").then((module) => module.lightRibbedSphereVisualization),
  },
  {
    id: "ribbed-sphere-purple",
    name: "Purple sphere",
    theme: "purple",
    load: () => import("./ribbed-sphere.js").then((module) => module.purpleRibbedSphereVisualization),
  },
];

export function getVisualization(id) {
  return visualizations.find((visualization) => visualization.id === id) || visualizations[0];
}
