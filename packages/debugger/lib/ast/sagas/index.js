import debugModule from "debug";
const debug = debugModule("debugger:ast:sagas");

import { all, call, select } from "redux-saga/effects";

import * as data from "lib/data/sagas";

import ast from "../selectors";

import jsonpointer from "json-pointer";

function* walk(
  compilationId,
  internalFor,
  sourceId,
  node,
  pointer = "",
  parentId = null
) {
  debug("walking %d %o %o", sourceId, pointer, node);

  yield* handleEnter(
    compilationId,
    internalFor,
    sourceId,
    node,
    pointer,
    parentId
  );

  if (Array.isArray(node)) {
    for (let [i, child] of node.entries()) {
      yield* walk(
        compilationId,
        internalFor,
        sourceId,
        child,
        `${pointer}/${i}`,
        parentId
      );
    }
  } else if (node && node.nodeType === "YulBlock") {
    //defer to yul handler!
    yield* handleYul(
      compilationId,
      internalFor,
      sourceId,
      node,
      pointer,
      parentId
    );
  } else if (node instanceof Object) {
    for (let [key, child] of Object.entries(node)) {
      yield* walk(
        compilationId,
        internalFor,
        sourceId,
        child,
        `${pointer}/${key}`,
        node.id
      );
    }
  }

  yield* handleExit(compilationId, internalFor, sourceId, node, pointer);
}

function* handleEnter(
  compilationId,
  internalFor,
  sourceId,
  node,
  pointer,
  parentId
) {
  debug("entering %d %s", sourceId, pointer);

  if (!(node instanceof Object)) {
    return;
  }

  if (node.id !== undefined) {
    debug("%s recording scope %s", pointer, node.id);
    yield* data.scope(
      node.id,
      pointer,
      parentId,
      sourceId,
      compilationId,
      internalFor
    );
  }

  switch (node.nodeType) {
    case "VariableDeclaration":
      debug("%s recording variable %o", pointer, node);
      yield* data.declare(node, compilationId, internalFor);
      break;
    case "ContractDefinition":
    case "StructDefinition":
    case "EnumDefinition":
      debug("%s recording type %o", pointer, node);
      yield* data.defineType(node, compilationId); //we assume this will not happen in a generated source
      break;
  }
}

function* handleExit(compilationId, internalFor, sourceId, node, pointer) {
  debug("exiting %d %s", sourceId, pointer);

  // no-op right now
}

export function* visitAll() {
  const sources = yield select(ast.views.sources);

  yield all(
    sources
      .filter(({ ast }) => ast)
      .map(({ ast, id, compilationId, internalFor }) =>
        call(walk, compilationId, internalFor, id, ast)
      )
  );

  debug("done visiting");
}

function* handleYul(
  compilationId,
  internalFor,
  sourceId,
  node,
  pointer,
  parentId
) {
  yield* yulWalk(
    compilationId,
    internalFor,
    sourceId,
    node,
    pointer,
    node,
    pointer,
    parentId
  );
}

function* yulWalk(
  compilationId,
  internalFor,
  sourceId,
  node,
  pointer,
  base,
  basePointer,
  parentId = undefined
) {
  yield* handleYulEnter(
    compilationId,
    internalFor,
    sourceId,
    node,
    pointer,
    base,
    basePointer,
    parentId
  );

  if (Array.isArray(node)) {
    for (let [i, child] of node.entries()) {
      yield* yulWalk(
        compilationId,
        internalFor,
        sourceId,
        child,
        `${pointer}/${i}`,
        base,
        basePointer
      ); //no parent ID for subnodes
    }
  } else if (node instanceof Object) {
    for (let [key, child] of Object.entries(node)) {
      yield* yulWalk(
        compilationId,
        internalFor,
        sourceId,
        child,
        `${pointer}/${key}`,
        base,
        basePointer
      ); //no parent ID for subnodes
    }
  }

  yield* handleYulExit(
    compilationId,
    internalFor,
    sourceId,
    node,
    pointer,
    base,
    basePointer,
    parentId
  );
}

function* handleYulExit(
  compilationId,
  internalFor,
  sourceId,
  node,
  pointer,
  base,
  basePointer,
  _parentId = undefined
) {
  debug("exiting %d %s", sourceId, pointer);

  // no-op right now
}

function* handleYulEnter(
  compilationId,
  internalFor,
  sourceId,
  node,
  pointer,
  base,
  basePointer,
  parentId = undefined
) {
  debug("entering %d %s", sourceId, pointer);

  if (!node) {
    return;
  }

  if (node.src !== undefined) {
    debug("scoping!");
    yield* data.yulScope(
      pointer,
      sourceId,
      compilationId,
      internalFor,
      parentId
    );
  }

  if (node.nodeType === "YulTypedName") {
    let scopePointer = findYulScopePointer(node, pointer, base, basePointer);
    yield* data.yulDeclare(
      node,
      pointer,
      scopePointer,
      sourceId,
      compilationId,
      internalFor
    );
  }
}

function findYulScopePointer(node, pointer, base, basePointer) {
  //walk upward until we find a YulBlock or YulFunctionDefinition,
  //with a special case for YulForLoop
  debug("pointer: %s", pointer);
  debug("basePointer: %s", basePointer);
  let relativePointer = pointer.slice(basePointer.length);
  debug("relativePointer: %s", relativePointer);
  let relativeParentPointer = relativePointer.replace(/\/[^/]*$/, ""); //chop off last element
  let parentPointer = basePointer + relativeParentPointer; //make it absolute again
  debug("parentPointer: %s", parentPointer);
  let parent = jsonpointer.get(base, relativeParentPointer);
  //NOTE: if node === base, then we'll just get parent = node,
  //but that's fine, since we necessarily have base.nodeType === "YulBlock"
  //(and the real parent of base is certainly not a for loop!)
  if (node.nodeType === "YulBlock") {
    if (parent.nodeType === "YulForLoop") {
      if (pointer === `${parentPointer}/pre`) {
        //variables declared in the pre block of a for loop
        //are visible across the entire for loop
        return parentPointer;
      } else {
        return pointer;
      }
    } else {
      return pointer;
    }
  } else if (node.nodeType === "YulFunctionDefinition") {
    return pointer;
  } else {
    return findYulScopePointer(parent, parentPointer, base, basePointer);
  }
}
