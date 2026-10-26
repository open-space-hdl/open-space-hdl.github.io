"""Golden data of the OpenCompact models of the Composer (assets/composer/js/model/ocp.js).

The Composer ports the models of OpenCompact to JavaScript: the throughput model of the predictor with the period of
consecutive images (tools/ocp_throughput.py, checked cycle by cycle by the testbenches of OpenCompact), the length of
the header and the upper bound on the length of the compressed image (tools/ocp_model.py, checked against the CNES
reference software and against every compressed image of the regression). This script runs the Python models of a
clone of OpenCompact at the pinned commit for every configuration of its regression (tools/ocp_configs.py ALL: the
named and the random configurations) and writes their results to tests/golden/ocp_models.json, where the unit tests
compare the port with them. For the runtime configurations of the regression (tools/ocp_configs.py RUNTIME,
RuntimeConfig_g = true) it writes the period of two images of the maxima and the start of every image of the seeded
sequence of the regression (runtime_accept_cycles); for the runtime parameter configurations (RUNTIME_PARAMS,
RuntimeParams_g = true) also with the M of every image, and the maximum of max_image_bytes over the parameter ranges.

    python tools/composer_ocp_golden.py <clone of opencompact at the pin>
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "golden" / "ocp_models.json"


def main() -> None:
    clone = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(clone / "tools"))
    import ocp_configs  # noqa: E402
    import ocp_generics  # noqa: E402
    import ocp_model  # noqa: E402
    import ocp_throughput  # noqa: E402
    import ocp_wrapper  # noqa: E402

    commit = subprocess.run(["git", "-C", str(clone), "rev-parse", "HEAD"], capture_output=True, text=True,
                            check=True).stdout.strip()
    configs = []
    for name, cfg in ocp_configs.ALL.items():
        g = ocp_generics.generics(cfg)
        # the generics as the Composer holds them: VHDL literals of the vectors and of the supplementary tables
        vhdl = {k: (v if isinstance(v, (bool, int)) else ocp_wrapper.value(k, v).strip('"')
                    if k in ocp_wrapper.STRINGS else ocp_wrapper.value(k, v)) for k, v in g.items()}
        entry = {"name": name, "generics": vhdl, "headerBytes": len(ocp_model.header(cfg)),
                 "maxImageBytes": ocp_model.max_image_bytes(cfg)}
        for spec in (True, False):
            lat = ocp_throughput.latencies(g, spec)
            st = ocp_throughput.stride_params(g, lat)
            res = {"depth": lat["depth"], "spec": lat["spec"], "lW": lat["l_w"], "lFix": lat["l_fix"],
                   "lCross": lat["l_cross"], "imagePeriod": ocp_throughput.image_period(g, spec)}
            if st is not None:
                res["stride"] = {"s": st["s"], "skew": st["skew"]}
                res["inSpan"], res["outSpan"] = ocp_throughput.stride_spans(g, lat, st)
            else:
                res["span1"] = ocp_throughput.issue_span(g, spec, 1)
                res["span2"] = ocp_throughput.issue_span(g, spec, 2)
            entry["speculation" if spec else "noSpeculation"] = res
        configs.append(entry)
    # The runtime configurations of the regression (RuntimeConfig_g = true; the dimensions of a configuration are the
    # maxima): the period of two images of the maxima, and the acceptance cycles of the first sample of every image of
    # the seeded sequence of the regression (TC-CO-52), relative to the first; both from runtime_accept_cycles
    runtime = []
    for name, cfg in ocp_configs.RUNTIME.items():
        g = dict(ocp_generics.generics(cfg), RuntimeConfig_g=True)
        vhdl = {k: (v if isinstance(v, (bool, int)) else ocp_wrapper.value(k, v).strip('"')
                    if k in ocp_wrapper.STRINGS else ocp_wrapper.value(k, v)) for k, v in g.items()}
        maxima = (g["XSize_g"], g["YSize_g"], g["ZSize_g"])
        dims = [tuple(d[:3]) for d in ocp_configs.runtime_sequence(cfg)]
        entry = {"name": name, "generics": vhdl, "imageStartCycles": ocp_throughput.image_start_cycles(g),
                 "dims": [list(d) for d in dims]}
        for spec in (True, False):
            two = ocp_throughput.runtime_accept_cycles(g, [maxima, maxima], spec)
            seq = ocp_throughput.runtime_accept_cycles(g, dims, spec)
            starts, k = [], 0
            for nx, ny, nz in dims:
                starts.append(seq[k] - seq[0])
                k += nx * ny * nz
            entry["speculation" if spec else "noSpeculation"] = {
                "imagePeriod": two[maxima[0] * maxima[1] * maxima[2]] - two[0], "starts": starts}
        runtime.append(entry)
    # The runtime parameter configurations of the regression (tools/ocp_configs.py RUNTIME_PARAMS, RuntimeParams_g =
    # true; M, gamma* and r of a configuration are the maxima): the period of two images of the maxima, the start of
    # every image of the seeded sequence of the regression (TC-CO-59) with the M the core takes in BI order, and the
    # maximum of max_image_bytes over the parameter ranges of every image (Umax 8 to 32, gamma0 from 1 to
    # min(8, gamma* - 1), gamma* from max(4, gamma0 + 1) to the maximum; CO-RP-02)
    params = []
    for name, cfg in getattr(ocp_configs, "RUNTIME_PARAMS", {}).items():
        g = dict(ocp_generics.generics(cfg), RuntimeConfig_g=True, RuntimeParams_g=True)
        vhdl = {k: (v if isinstance(v, (bool, int)) else ocp_wrapper.value(k, v).strip('"')
                    if k in ocp_wrapper.STRINGS else ocp_wrapper.value(k, v)) for k, v in g.items()}
        maxima = (g["XSize_g"], g["YSize_g"], g["ZSize_g"])
        bi = g["EncodingOrder_g"] == "BI"
        dims = [tuple(taken[:3]) + ((p_taken[1],) if bi else ())
                for _, taken, _, p_taken in ocp_configs.runtime_params_sequence(cfg)]
        bound = ocp_model.max_image_bytes(cfg)
        if cfg["entropy_coder_type"] != 2:
            gs_max = cfg["gamma_star"]
            bound = max(ocp_model.max_image_bytes(dict(cfg, large_u_max=32, gamma_0=g0, gamma_star=gs))
                        for g0 in range(1, min(8, gs_max - 1) + 1) for gs in range(max(4, g0 + 1), gs_max + 1))
        entry = {"name": name, "generics": vhdl, "maxImageBytes": bound, "dims": [list(d) for d in dims]}
        for spec in (True, False):
            two = ocp_throughput.runtime_accept_cycles(g, [maxima, maxima], spec)
            seq = ocp_throughput.runtime_accept_cycles(g, dims, spec)
            starts, k = [], 0
            for dim in dims:
                starts.append(seq[k] - seq[0])
                k += dim[0] * dim[1] * dim[2]
            entry["speculation" if spec else "noSpeculation"] = {
                "imagePeriod": two[maxima[0] * maxima[1] * maxima[2]] - two[0], "starts": starts}
        params.append(entry)
    constants = {"LE_MAX_OUT": ocp_model.LE_MAX_OUT, "LE_MAX_FLUSH": ocp_model.LE_MAX_FLUSH}
    OUT.write_text(json.dumps({"source": "opencompact", "commit": commit, "constants": constants, "configs": configs,
                               "runtime": runtime, "runtimeParams": params}, indent=1) + "\n", encoding="utf-8",
                   newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(configs)} configurations, {len(runtime)} runtime configurations and"
          f" {len(params)} runtime parameter configurations at {commit[:10]}")


if __name__ == "__main__":
    main()
