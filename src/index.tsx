import { render } from "solid-js/web";
import { App } from "./App";
import { startPwa } from "./pwa";
import "./styles.css";

startPwa();
render(() => <App />, document.getElementById("root")!);
