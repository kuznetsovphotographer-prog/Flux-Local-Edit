(function () {
  function now() {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function createLogger(element) {
    const lines = [];

    function write(level, message) {
      const text = `[${now()}] ${level}: ${message}`;
      lines.push(text);
      if (lines.length > 180) {
        lines.shift();
      }
      if (element) {
        element.textContent = lines.join("\n");
        element.scrollTop = element.scrollHeight;
      }
    }

    return {
      clear() {
        lines.length = 0;
        if (element) {
          element.textContent = "";
        }
      },
      info(message) {
        console.log(message);
        write("INFO", message);
      },
      warn(message) {
        console.warn(message);
        write("WARN", message);
      },
      error(message) {
        console.error(message);
        write("ERROR", message);
      }
    };
  }

  globalThis.Flux2Logger = { createLogger };
})();
