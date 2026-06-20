const React = window.React;
const _origCreateElement = React.createElement;

const VOID_ELEMENTS = new Set([
  "area","base","br","col","embed","hr","img","input",
  "link","meta","param","source","track","wbr","menuitem",
]);

function _safeCreateElement(type, props, ...rest) {
  if (typeof type === "string" && VOID_ELEMENTS.has(type)) {
    if (props && props.children != null && props.children !== "") {
      const clean = {};
      for (const k in props) if (k !== "children") clean[k] = props[k];
      return _origCreateElement.apply(React, [type, clean]);
    }
    if (rest.length > 0 && rest[0] != null && rest[0] !== "") {
      return _origCreateElement.call(React, type, props);
    }
  }
  return _origCreateElement.apply(React, [type, props, ...rest]);
}

function _jsx(type, props, ...rest) {
  return _safeCreateElement(type, props, ...rest);
}

export const jsx = _jsx;
export const jsxs = _jsx;
export const jsxDEV = _jsx;
export const Fragment = React.Fragment;
export default { jsx: _jsx, jsxs: _jsx, jsxDEV: _jsx, Fragment: React.Fragment };
