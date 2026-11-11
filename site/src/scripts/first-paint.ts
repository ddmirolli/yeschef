import { initialView } from './initial-view';
document.documentElement.setAttribute('data-view', initialView(location.search));
