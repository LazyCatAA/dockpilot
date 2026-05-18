const process = {
  env: {},
  argv: [],
  browser: true,
  cwd() {
    return "/";
  },
  nextTick(callback, ...args) {
    Promise.resolve().then(() => callback(...args));
  },
};

export default process;
