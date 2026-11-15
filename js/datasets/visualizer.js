
export function renderPitchGraph(tones, measurements, container, options = {}) {
    if (!Array.isArray(tones) || tones.length === 0) {
        throw new Error("A non-empty tones array is required.");
    }

    if (!container) {
        throw new Error("A graph container is required.");
    }

    const width = 900;
    const height = 430;

    const margin = {
        top: 35,
        right: 35,
        bottom: 105,
        left: 85
    };

    const graphWidth = width - margin.left - margin.right;
    const graphHeight = height - margin.top - margin.bottom;

    const timelineDuration = options.timelineDuration ??
        Math.max(...tones.map(t => t.startTime + t.duration));

    const minFrequency = Number(options.minFrequency ?? 100);
    const maxFrequency = Number(options.maxFrequency ?? 1000);

    if (
        !Number.isFinite(minFrequency) ||
        !Number.isFinite(maxFrequency) ||
        maxFrequency <= minFrequency
    ) {
        throw new Error("Maximum frequency must exceed minimum frequency.");
    }

    const noteColor = options.noteColor ?? "#3978c5";
    const showGrid = options.showGrid !== false;
    const cursorTime = Number(options.cursorTime ?? 0);

    const x = time =>
        margin.left + (time / timelineDuration) * graphWidth;

    const y = frequency =>
        margin.top + graphHeight -
        ((frequency - minFrequency) / (maxFrequency - minFrequency)) * graphHeight;

    const svgNS = "http://www.w3.org/2000/svg";

    function createElement(name, attributes = {}) {
        const element = document.createElementNS(svgNS, name);

        for (const [key, value] of Object.entries(attributes)) {
            element.setAttribute(key, String(value));
        }

        return element;
    }

    function addText(parent, content, attributes = {}) {
        const element = createElement("text", attributes);
        element.textContent = content;
        parent.appendChild(element);
        return element;
    }

    const svg = createElement("svg", {
        viewBox: `0 0 ${width} ${height}`,
        width: "100%",
        role: "img",
        "aria-labelledby": "pitch-title pitch-description"
    });

    const title = createElement("title", { id: "pitch-title" });
    title.textContent = "Earth Information Jukebox pitch graph";

    const description = createElement("desc", {
        id: "pitch-description"
    });

    description.textContent =
        "A graph showing generated sound frequencies over the audio timeline. " +
        "Horizontal segments represent notes. Gaps represent silence. " +
        "Calendar dates mark the original Earth measurements.";

    svg.append(title, description);

    // Background
    svg.appendChild(createElement("rect", {
        x: margin.left,
        y: margin.top,
        width: graphWidth,
        height: graphHeight,
        fill: "transparent"
    }));

    // Frequency grid and labels
    const frequencySteps = 5;

    for (let i = 0; i <= frequencySteps; i++) {
        const frequency =
            minFrequency +
            (maxFrequency - minFrequency) * (i / frequencySteps);

        const position = y(frequency);

        if (showGrid) {
            svg.appendChild(createElement("line", {
                x1: margin.left,
                y1: position,
                x2: width - margin.right,
                y2: position,
                stroke: "currentColor",
                "stroke-opacity": "0.18",
                "stroke-dasharray": "4 5"
            }));
        }

        addText(svg, `${Math.round(frequency)} Hz`, {
            x: margin.left - 12,
            y: position + 5,
            "text-anchor": "end",
            "font-size": "12",
            fill: "currentColor"
        });
    }

    // Time grid and labels
    for (let i = 0; i <= 4; i++) {
        const time = timelineDuration * (i / 4);
        const position = x(time);

        if (showGrid) {
            svg.appendChild(createElement("line", {
                x1: position,
                y1: margin.top,
                x2: position,
                y2: margin.top + graphHeight,
                stroke: "currentColor",
                "stroke-opacity": "0.18",
                "stroke-dasharray": "4 5"
            }));
        }

        addText(svg, `${time.toFixed(1)} s`, {
            x: position,
            y: margin.top + graphHeight + 22,
            "text-anchor": "middle",
            "font-size": "12",
            fill: "currentColor"
        });
    }

    // Axes
    svg.appendChild(createElement("line", {
        x1: margin.left,
        y1: margin.top,
        x2: margin.left,
        y2: margin.top + graphHeight,
        stroke: "currentColor",
        "stroke-width": "2"
    }));

    svg.appendChild(createElement("line", {
        x1: margin.left,
        y1: margin.top + graphHeight,
        x2: width - margin.right,
        y2: margin.top + graphHeight,
        stroke: "currentColor",
        "stroke-width": "2"
    }));

    // Axis titles
    addText(svg, "Frequency (Hz)", {
        x: 20,
        y: height / 2,
        transform: `rotate(-90 20 ${height / 2})`,
        "text-anchor": "middle",
        "font-size": "14",
        fill: "currentColor"
    });

    addText(svg, "Audio timeline (seconds)", {
        x: width / 2,
        y: height - 12,
        "text-anchor": "middle",
        "font-size": "14",
        fill: "currentColor"
    });

    // Original measurement dates
    measurements.forEach(point => {
        const audioTime =
            ((point.timestamp - measurements[0].timestamp) /
            (measurements[measurements.length - 1].timestamp -
            measurements[0].timestamp)) * 6;

        const date = new Date(point.timestamp * 1000);

        const dateLabel = date.toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            timeZone: "UTC"
        });

        addText(svg, dateLabel, {
            x: x(audioTime),
            y: margin.top + graphHeight + 47,
            "text-anchor": "middle",
            "font-size": "11",
            fill: "currentColor"
        });
    });

    // Draw note segments
    tones.forEach((tone, index) => {
        const note = createElement("line", {
            x1: x(tone.startTime),
            y1: y(tone.frequency),
            x2: x(tone.startTime + tone.duration),
            y2: y(tone.frequency),
            stroke: noteColor,
            "stroke-width": "9",
            "stroke-linecap": "round"
        });

        note.setAttribute(
            "aria-label",
            `Note ${index + 1}: ${tone.frequency.toFixed(1)} hertz`
        );

        svg.appendChild(note);
    });

    // Movable time cursor
    const safeCursorTime = Math.max(
        0,
        Math.min(cursorTime, timelineDuration)
    );

    const cursorX = x(safeCursorTime);

    svg.appendChild(createElement("line", {
        x1: cursorX,
        y1: margin.top,
        x2: cursorX,
        y2: margin.top + graphHeight,
        stroke: "#d97706",
        "stroke-width": "3",
        "stroke-dasharray": "7 4"
    }));

    svg.appendChild(createElement("circle", {
        cx: cursorX,
        cy: margin.top + graphHeight,
        r: "6",
        fill: "#d97706"
    }));

    container.replaceChildren(svg);
}
