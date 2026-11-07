import { beforeAll } from "vitest";
import * as addonA11yAnnotations from "@storybook/addon-a11y/preview";
import { setProjectAnnotations } from "@storybook/react-vite";
import * as projectAnnotations from "./preview";

// Load the same annotations the Storybook UI uses — the react-vite renderer,
// addon-a11y's preview (its afterEach hook fails the test on a11y violations
// when parameters.a11y.test === "error"), and our own preview (decorators,
// globals, a11y parameters) — so browser tests render and check stories
// exactly like the workbench.
const project = setProjectAnnotations([addonA11yAnnotations, projectAnnotations]);

beforeAll(project.beforeAll);
