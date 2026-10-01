# Static analysis of R cells against the kernel's global environment.
#
# The R version of analyze_cells.py (design iteration 1.79). For each cell:
# the names it defines and uses, the columns of data frames it touches, its
# formulas, and its decisions, in the message of the Python version, so that
# the view draws the chips of an R cell as it draws those of a Python cell. A
# decision is a value that changes the result:
#
# - `defaulted`: a formal of the analyst's own function, from a file of the
#   kernel's folder that source() read, left at its default, such as
#   `slope = "month"`, or the constant of the file that the default names;
# - `library_default`: a parameter of a known R function left at a default
#   that changes results, such as `REML = TRUE` in lme4's lmer (the table
#   `known` below);
# - `literal`: a value written in the cell, such as `REML = FALSE` in a call,
#   or a constant assigned at the top level, such as `MIN_DAYS <- 14`.
#
# A function of the analyst's file also gives its first lines, under
# `attachments`, as in the Python version.
#
# R's own parser reads the cell (`parse` and `utils::getParseData`), and no
# code of the cell runs. Each decision of a call is keyed by that call: where
# the cell names the function, its line from 1 and its column in UTF-8 bytes
# from the start of the line, as the Python version counts them. Calls that
# leave the same parameter at the same value share one decision, which lists
# them in `calls`, each with the frame that it joins, reads or works on, in
# one word (`target`). A decision's `function` names the function with its
# package, `stats::t.test`, so that a name with a dot stays one name.
#
# The kernel holds what the cell calls: a function that the global
# environment or an attached package defines is read for its formals, and an
# S3 generic for the method that the class of its first argument picks. A
# function of the table whose package is not loaded is read from the table.
#
# With `signatures` in the arguments (the view's setting "Find more defaults
# with AI", design iteration 1.53), a cell also lists the functions of R's
# packages that it calls, under `signatures`, as the Python version does:
# each function's package and version, each formal that has a default, with
# the default as code, and each call with the formals that it leaves at
# their defaults. A default that looks like a key is left out, the
# analyst's own functions are left out, and a cell lists at most
# `max_signatures` functions.
#
# The frontend bundle holds the text of this file (scripts/embed-kernel-code.mjs),
# runs it in the global environment, calls the function with the JSON
# arguments and removes it again (the R adapter in src/model/languages.ts).
# It needs jsonlite and IRdisplay, which R kernels depend on. The result goes
# out as display data with a MIME type that output areas do not render.
.whybook_analyze_cells <- function(args) {
  max_decisions <- if (is.null(args$max_decisions)) 6L else as.integer(args$max_decisions)
  read_signatures <- isTRUE(args$signatures)
  max_signatures <- if (is.null(args$max_signatures)) 8L else as.integer(args$max_signatures)
  global <- globalenv()
  # jsonlite writes NA of a flag or of a text as null, and NA of a number as
  # the text "NA": a number that may be missing is NA, a flag.

  # A key, a token or a password is no choice to try, and its text would go
  # into the notebook with the analysis. The server, the Python kernel code
  # and the view hold the same rule (privacy.py says it in full,
  # tests/data/secret_names.json holds its cases): only a string is a secret.
  secret_words <- c(
    "token", "secret", "secrets", "password", "passwords", "passwd", "pwd",
    "credential", "credentials", "bearer", "apikey", "auth"
  )
  secret_endings <- c("token", "secret", "password", "passwd", "apikey")
  secret_pairs <- c("api key", "access key", "private key", "secret key")
  secret_prefix <- paste0(
    "(?<![A-Za-z0-9])(?:sk-|sk_live_|sk_test_|hf_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abpr]-|xapp-",
    "|AKIA|ASIA|AIza|ya29\\.|eyJ|npm_|pypi-)[A-Za-z0-9_.=-]{16,}"
  )
  # A password in a URL, as a connection string holds it, and a query parameter named as a secret.
  url_password <- "[A-Za-z][A-Za-z0-9+.-]*://[^\\s/?#@:]*:[^\\s/?#@]+@"
  query_name <- "[?&][A-Za-z0-9_.-]+=[^&#\\s]"
  all_of <- function(pattern, text) regmatches(text, gregexpr(pattern, text, perl = TRUE))[[1]]

  secret_name <- function(name) {
    parts <- tolower(all_of("[A-Z]+(?![a-z])|[A-Z]?[a-z]+", name))
    if (any(parts %in% secret_words)) {
      return(TRUE)
    }
    for (ending in secret_endings) {
      if (any(endsWith(parts, ending))) {
        return(TRUE)
      }
    }
    length(parts) > 1 && any(paste(parts[-length(parts)], parts[-1]) %in% secret_pairs)
  }

  # Whether a decision holds a secret, from its name and its value as R code.
  looks_secret <- function(name, value) {
    text <- tryCatch(str2lang(value), error = function(e) NULL)
    if (!is.character(text) || length(text) != 1 || is.na(text)) {
      return(FALSE)
    }
    if (secret_name(name)) {
      return(TRUE)
    }
    if (grepl(secret_prefix, text, perl = TRUE) || grepl(url_password, text, perl = TRUE)) {
      return(TRUE)
    }
    keys <- sub("^[?&]([A-Za-z0-9_.-]+)=.*$", "\\1", all_of(query_name, text), perl = TRUE)
    if (any(vapply(keys, secret_name, logical(1)))) {
      return(TRUE)
    }
    runs <- all_of("[A-Za-z0-9]{20,}", text)
    any(nchar(runs) >= 32 | (grepl("[A-Z]", runs) & grepl("[a-z]", runs) & grepl("[0-9]", runs)))
  }

  # The two options that set defaults of R's model functions, as they are now.
  contrasts_now <- getOption("contrasts")
  coding <- if (is.character(contrasts_now) && "unordered" %in% names(contrasts_now)) {
    contrasts_now[["unordered"]]
  } else {
    "contr.treatment"
  }
  na_now <- getOption("na.action")
  na_action <- if (is.character(na_now) && length(na_now) == 1) na_now else "na.omit"

  # The defaults that change results, by function. `params` gives the order
  # of the formals, for a function whose package is not loaded; `when` says
  # whether the default matters in a call, from what the call passes. A
  # default without a parameter, such as the sums of squares of anova, has
  # `param` NA.
  model_frame <- list(
    contrasts = list(
      value = deparse(coding),
      note = if (coding == "contr.treatment") {
        "treatment coding: each coefficient compares a level with the first level, where SAS compares it with the last"
      } else {
        "the coding of factors that options(contrasts) sets in this session"
      },
      when = function(call) call$factors
    ),
    na.action = list(
      value = na_action,
      note = "rows with a missing value in any variable of the model are dropped",
      when = function(call) TRUE
    )
  )
  na_strings <- list(
    value = "\"NA\"",
    note = "only the text NA reads as missing: in a text column an empty cell stays an empty text, and a value such as n/a turns a column of numbers into text",
    when = function(call) TRUE
  )
  always <- function(call) TRUE
  # The readers of delimited text that set header = TRUE, unlike read.table.
  header_line <- list(
    value = "TRUE",
    note = "the first line names the columns, and is not read as data: header = FALSE reads it as data",
    when = always
  )
  known <- list(
    lm = list(package = "stats", params = c(
      "formula", "data", "subset", "weights", "na.action", "method", "model",
      "x", "y", "qr", "singular.ok", "contrasts", "offset"
    ), defaults = model_frame),
    glm = list(package = "stats", params = c(
      "formula", "family", "data", "weights", "subset", "na.action", "start",
      "etastart", "mustart", "offset", "control", "model", "method", "x", "y",
      "singular.ok", "contrasts"
    ), defaults = c(list(family = list(
      value = "gaussian",
      note = "normal errors and an identity link, a linear model: a 0/1 outcome needs binomial, a count poisson",
      when = always
    )), model_frame)),
    lmer = list(package = "lme4", also = "lmerTest", params = c(
      "formula", "data", "REML", "control", "start", "verbose", "subset",
      "weights", "na.action", "offset", "contrasts", "devFunOnly"
    ), defaults = c(list(REML = list(
      value = "TRUE",
      note = "REML fit: likelihoods cannot compare models with different fixed effects",
      when = always
    )), model_frame)),
    glmer = list(package = "lme4", params = c(
      "formula", "data", "family", "control", "start", "verbose", "nAGQ",
      "subset", "weights", "na.action", "offset", "contrasts", "mustart",
      "etastart", "devFunOnly"
    ), defaults = c(list(nAGQ = list(
      value = "1L",
      note = "Laplace approximation of the likelihood: more quadrature points, nAGQ > 1, are more accurate with one random intercept",
      when = always
    )), model_frame)),
    anova = list(package = "stats", params = "object", defaults = list(SS = list(
      param = NA_character_,
      value = "Type I",
      note = "sequential sums of squares: each term is tested after the terms before it, so their order changes the result; car::Anova tests Type II or III",
      when = function(call) call$positional == 1L
    ))),
    Anova = list(package = "car", params = "mod", defaults = list(type = list(
      value = "\"II\"",
      note = "Type II tests: each term after the terms that do not contain it; Type III needs sum-to-zero contrasts",
      when = always
    ))),
    t.test = list(package = "stats", params = c(
      "x", "y", "alternative", "mu", "paired", "var.equal", "conf.level"
    ), defaults = list(var.equal = list(
      value = "FALSE",
      note = "Welch's t test: the two groups may have different variances, and the degrees of freedom are not whole",
      when = function(call) call$two_samples
    ))),
    merge = list(package = "base", params = c(
      "x", "y", "by", "by.x", "by.y", "all", "all.x", "all.y", "sort",
      "suffixes", "no.dups", "incomparables"
    ), defaults = list(all = list(
      value = "FALSE",
      note = "rows without a match in both frames are dropped",
      when = function(call) !any(c("all.x", "all.y") %in% call$passed)
    ))),
    cor = list(package = "stats", params = c("x", "y", "use", "method"), defaults = list(method = list(
      value = "\"pearson\"", note = "linear correlation, sensitive to outliers", when = always
    ))),
    cor.test = list(package = "stats", params = c("x", "y"), defaults = list(method = list(
      value = "\"pearson\"", note = "linear correlation, sensitive to outliers", when = always
    ))),
    quantile = list(package = "stats", params = c("x", "probs", "na.rm", "names", "type", "digits"), defaults = list(type = list(
      value = "7",
      note = "linear interpolation between the order statistics; the default of SAS is type 2, and SPSS computes type 6",
      when = always
    ))),
    p.adjust = list(package = "stats", params = c("p", "method", "n"), defaults = list(method = list(
      value = "\"holm\"",
      note = "Holm's correction holds the chance of any false positive; method = \"BH\" holds the share of false discoveries instead",
      when = always
    ))),
    read.csv = list(package = "utils", params = c("file", "header", "sep", "quote", "dec", "fill", "comment.char"), defaults = list(header = header_line, na.strings = na_strings)),
    read.csv2 = list(package = "utils", params = c("file", "header", "sep", "quote", "dec", "fill", "comment.char"), defaults = list(header = header_line, na.strings = na_strings)),
    read.delim = list(package = "utils", params = c("file", "header", "sep", "quote", "dec", "fill", "comment.char"), defaults = list(header = header_line, na.strings = na_strings)),
    read.delim2 = list(package = "utils", params = c("file", "header", "sep", "quote", "dec", "fill", "comment.char"), defaults = list(header = header_line, na.strings = na_strings)),
    read.table = list(package = "utils", params = c("file", "header", "sep", "quote", "dec"), defaults = list(
      header = list(value = "FALSE", note = "the first line is read as data, not as the names of the columns", when = always),
      na.strings = na_strings
    )),
    chisq.test = list(package = "stats", params = c("x", "y", "correct"), defaults = list(correct = list(
      value = "TRUE", note = "Yates' continuity correction on a 2 by 2 table: the p-value is larger", when = always
    ))),
    prop.test = list(package = "stats", params = c("x", "n", "p", "alternative", "conf.level", "correct"), defaults = list(correct = list(
      value = "TRUE", note = "Yates' continuity correction: the p-value is larger and the interval wider", when = always
    ))),
    predict = list(package = "stats", params = "object", defaults = list(type = list(
      value = "\"link\"",
      note = "predictions on the scale of the linear predictor, log odds for a logistic model: type = \"response\" gives probabilities",
      when = function(call) inherits(call$object, "glm")
    ))),
    table = list(package = "base", params = character(0), defaults = list(useNA = list(
      value = "\"no\"", note = "missing values are not counted", when = always
    )))
  )
  # Readers whose formals end in `...`, which they pass on to read.table.
  forwards <- c(read.csv = "read.table", read.csv2 = "read.table", read.delim = "read.table", read.delim2 = "read.table")
  # Arguments that name data rather than choose how to analyse it.
  skipped_params <- c(
    "data", "x", "y", "X", "formula", "object", "subset", "by", "by.x", "by.y",
    "newdata", "names", "labels", "main", "sub", "xlab", "ylab", "title",
    "col", "sep", "collapse", "verbose", "quiet", "seed", "envir", "FUN",
    "row.names", "col.names", "outcome", "mod", "group", "groups"
  )
  # Calls whose arguments are not analysis choices: source() reads the
  # analyst's file, as an import does in Python, and the named arguments of
  # cbind() or data.frame() name columns.
  skipped_functions <- c(
    "print", "cat", "message", "format", "formatC", "sprintf", "paste",
    "paste0", "round", "signif", "c", "list", "length", "seq_len",
    "seq_along", "seq", "rep", "nrow", "ncol", "str", "invisible", "library",
    "require", "requireNamespace", "suppressMessages", "suppressWarnings",
    "suppressPackageStartupMessages", "display", "set.seed", "source", "sys.source",
    "cbind", "rbind", "data.frame", "expand.grid", "setNames", "structure"
  )
  family_functions <- c(
    "binomial", "poisson", "gaussian", "Gamma", "inverse.gaussian", "quasi",
    "quasibinomial", "quasipoisson"
  )
  reader <- function(name) grepl("^(read|scan)[._]", name) || name == "readRDS"

  frames <- list()
  for (name in ls(envir = global)) {
    value <- get0(name, envir = global, inherits = FALSE)
    if (is.data.frame(value)) {
      frames[[name]] <- names(value)
    }
  }
  is_global <- function(name) exists(name, envir = global, inherits = FALSE)
  versions <- new.env()
  version_of <- function(package) {
    if (is.null(versions[[package]])) {
      versions[[package]] <- tryCatch(as.character(utils::packageVersion(package)), error = function(e) NA_character_)
    }
    versions[[package]]
  }

  # The function a call runs, as the kernel holds it: from its package when
  # the call names one and the package is loaded, else from the global
  # environment and the attached packages. NULL when it is not there.
  resolve <- function(name, package) {
    found <- if (!is.na(package)) {
      if (isNamespaceLoaded(package)) get0(name, envir = asNamespace(package), inherits = FALSE) else NULL
    } else {
      get0(name, envir = global, mode = "function")
    }
    if (is.function(found)) found else NULL
  }
  package_of <- function(fn) {
    env <- environment(fn)
    if (is.null(env)) "base" else environmentName(env)
  }
  formals_of <- function(fn) {
    if (is.primitive(fn)) formals(args(fn)) else formals(fn)
  }
  before_dots <- function(params) {
    at <- match("...", params)
    if (is.na(at)) params else params[seq_len(at - 1)]
  }

  # The file under the kernel's folder that defines one of the analyst's
  # functions, as source() read it, or NA: a function that a cell defines
  # comes from no file.
  folder <- normalizePath(getwd(), winslash = "/", mustWork = FALSE)
  file_of <- function(fn) {
    srcfile <- attr(attr(fn, "srcref"), "srcfile")
    name <- if (is.environment(srcfile)) srcfile$filename else NULL
    if (!is.character(name) || length(name) != 1 || !nzchar(name)) {
      return(NA_character_)
    }
    if (!grepl("^(/|[A-Za-z]:)", name)) {
      name <- file.path(if (is.character(srcfile$wd)) srcfile$wd else folder, name)
    }
    path <- normalizePath(name, winslash = "/", mustWork = FALSE)
    if (file.exists(path) && startsWith(path, paste0(folder, "/"))) path else NA_character_
  }
  file_lines <- new.env()
  lines_of <- function(path) {
    if (is.null(file_lines[[path]])) {
      file_lines[[path]] <- tryCatch(readLines(path, warn = FALSE, encoding = "UTF-8"), error = function(e) character(0))
    }
    file_lines[[path]]
  }
  # The line of a file that assigns a constant, and its text: REML_REPS <- 3.
  line_of <- function(path, name) {
    written <- lines_of(path)
    at <- grep(paste0("^\\s*\\Q", name, "\\E\\s*(<<?-|=[^=])"), written, perl = TRUE)[1]
    if (is.na(at)) list(line = NA, text = NA_character_) else list(line = at, text = written[[at]])
  }
  # The first lines of the analyst's function, as Cell details shows the
  # file it comes from, with the line of the constant first when they do not
  # hold it.
  attachment_for <- function(fn, path, relative, symbol, highlight) {
    srcref <- attr(fn, "srcref")
    written <- lines_of(path)
    if (is.null(srcref) || !length(written)) {
      return(NULL)
    }
    start <- srcref[[1]]
    end <- min(srcref[[3]], length(written))
    shown <- lapply(seq.int(start, min(end, start + 11L)), function(number) list(number, written[[number]]))
    if (!is.null(highlight) && (highlight$line < start || highlight$line > min(end, start + 11L))) {
      shown <- c(list(list(highlight$line, highlight$text), list(NA, "\u2026")), shown)
    }
    list(
      file = relative, symbol = symbol, start = start, end = end, lines = shown,
      highlight = if (is.null(highlight)) list() else list(highlight$line)
    )
  }

  # A default as code: the first of the choices of a vector of strings, as
  # match.arg reads `c("two.sided", "less")`; NULL for one that looks like a
  # key, or that is too long to show.
  default_text <- function(name, value, env) {
    if (is.call(value) && identical(value[[1]], as.name("c")) && length(value) >= 3 &&
      all(vapply(as.list(value)[-1], is.character, logical(1)))) {
      value <- value[[2]]
    } else if (is.symbol(value) && !is.null(env)) {
      choices <- get0(as.character(value), envir = env)
      if (is.character(choices) && length(choices) >= 2) {
        value <- choices[[1]]
      }
    }
    text <- paste(deparse(value, width.cutoff = 500L), collapse = " ")
    if (nchar(text) > 200 || looks_secret(name, text)) NULL else text
  }

  # What the formals of a library function hold, read once in a request.
  read_functions <- new.env()
  signature_of <- function(key, name, package, method, extra) {
    if (!is.null(read_functions[[key]])) {
      return(read_functions[[key]])
    }
    params <- list()
    for (fn in c(list(method), extra)) {
      defaults <- formals_of(fn)
      for (param in names(defaults)) {
        # A formal without a default holds the empty symbol, which R reads as a missing argument.
        if (param == "..." || identical(defaults[[param]], quote(expr = ))) {
          next
        }
        value <- defaults[[param]]
        if (any(vapply(params, function(item) identical(item$name, param), logical(1)))) {
          next
        }
        text <- default_text(param, value, environment(fn))
        if (!is.null(text)) {
          params[[length(params) + 1]] <- list(name = param, default = text)
        }
      }
    }
    entry <- list(
      `function` = key, name = name, module = package, library = package,
      version = version_of(package), language = "R", params = params, calls = list()
    )
    read_functions[[key]] <- entry
    entry
  }

  analyze <- function(source) {
    exprs <- tryCatch(parse(text = source, keep.source = TRUE), error = function(e) e)
    if (inherits(exprs, "error")) {
      stop(paste("Parse error:", conditionMessage(exprs)), call. = FALSE)
    }
    pd <- utils::getParseData(exprs, includeText = TRUE)
    empty <- list(
      defs = list(), uses = list(), formulas = list(),
      columns = stats::setNames(list(), character(0)), decisions = list(), attachments = list()
    )
    if (is.null(pd) || nrow(pd) == 0) {
      if (read_signatures) {
        empty$signatures <- list()
      }
      return(empty)
    }
    lines <- strsplit(source, "\n", fixed = TRUE)[[1]]
    ids <- pd$id
    token <- pd$token
    text <- pd$text
    parent <- pd$parent
    row_by_id <- integer(max(ids))
    row_by_id[ids] <- seq_along(ids)
    row_of <- function(id) {
      if (is.na(id) || id <= 0 || id > length(row_by_id) || row_by_id[id] == 0L) NA_integer_ else row_by_id[id]
    }
    children <- split(seq_len(nrow(pd)), parent)
    kids <- function(row) {
      found <- children[[as.character(ids[row])]]
      if (is.null(found)) integer(0) else found
    }
    below <- function(row) {
      found <- integer(0)
      todo <- kids(row)
      while (length(todo)) {
        found <- c(found, todo[1])
        todo <- c(kids(todo[1]), todo[-1])
      }
      found
    }
    node_text <- function(row) {
      if (pd$terminal[row]) text[row] else utils::getParseText(pd, ids[row])
    }
    # The column in UTF-8 bytes of R's column, which counts characters and
    # moves a tab to the next multiple of 8.
    byte_col <- function(line, col) {
      chars <- strsplit(if (line <= length(lines)) lines[[line]] else "", "")[[1]]
      shown <- 0L
      bytes <- 0L
      for (char in chars) {
        if (shown + 1L >= col) {
          break
        }
        shown <- if (char == "\t") (shown %/% 8L + 1L) * 8L else shown + 1L
        bytes <- bytes + nchar(char, type = "bytes")
      }
      bytes
    }
    # The one child of an expr, when it has only one: x for the expr of x.
    only <- function(row) {
      found <- kids(row)
      if (length(found) == 1) found else NA_integer_
    }
    symbol_of <- function(row) {
      one <- only(row)
      if (!is.na(one) && token[one] %in% c("SYMBOL", "STR_CONST")) {
        name <- text[one]
        if (token[one] == "STR_CONST") name <- str2lang(name)
        return(name)
      }
      NA_character_
    }
    # The name an expression starts from: d for d$age, names(d)[2] or d[["a"]].
    root_of <- function(row) {
      while (!is.na(row)) {
        name <- symbol_of(row)
        if (!is.na(name)) {
          return(name)
        }
        found <- kids(row)
        if (!length(found) || token[found[1]] != "expr") {
          return(NA_character_)
        }
        first <- found[1]
        call_name <- kids(first)
        if (length(found) >= 2 && token[found[2]] == "'('" && length(call_name) &&
          any(token[call_name] == "SYMBOL_FUNCTION_CALL")) {
          # A replacement call, names(d) <- ...: the name is its first argument.
          row <- if (length(found) >= 3 && token[found[3]] == "expr") found[3] else NA_integer_
        } else {
          row <- first
        }
      }
      NA_character_
    }

    # Which rows lie in the body or the formals of a function the cell defines.
    in_function <- logical(nrow(pd))
    mark <- function(row, inside) {
      in_function[row] <<- inside
      found <- kids(row)
      defines <- any(token[found] %in% c("FUNCTION", "'\\\\'"))
      for (child in found) mark(child, inside || defines)
    }
    for (row in which(parent == 0)) mark(row, FALSE)

    # Assignments: the name each defines, and whether its target is the name alone.
    defs <- character(0)
    plain_targets <- integer(0)
    assignments <- list()
    for (row in which(!pd$terminal)) {
      found <- kids(row)
      if (length(found) != 3 || !(token[found[2]] %in% c("LEFT_ASSIGN", "EQ_ASSIGN", "RIGHT_ASSIGN"))) {
        next
      }
      right <- token[found[2]] == "RIGHT_ASSIGN"
      target <- if (right) found[3] else found[1]
      value <- if (right) found[1] else found[3]
      name <- root_of(target)
      if (is.na(name)) {
        next
      }
      plain <- !is.na(symbol_of(target))
      if (plain) {
        plain_targets <- c(plain_targets, only(target))
      }
      assignments[[length(assignments) + 1]] <- list(row = row, name = name, value = value, plain = plain, top = parent[row] == 0)
      if (!in_function[row]) {
        defs <- c(defs, name)
      }
    }
    # for (i in ...) defines i, and assign("k", ...) defines k.
    for (row in which(token == "forcond")) {
      found <- kids(row)
      at <- found[token[found] == "SYMBOL"]
      if (length(at) && !in_function[row]) {
        defs <- c(defs, text[at[1]])
        plain_targets <- c(plain_targets, at[1])
      }
    }
    for (row in which(token == "SYMBOL_FUNCTION_CALL" & text == "assign")) {
      call_row <- row_of(parent[row_of(parent[row])])
      if (is.na(call_row) || in_function[call_row]) {
        next
      }
      found <- kids(call_row)
      first <- found[match("'('", token[found]) + 1]
      one <- if (!is.na(first) && token[first] == "expr") only(first) else NA_integer_
      if (!is.na(one) && token[one] == "STR_CONST") {
        defs <- c(defs, str2lang(text[one]))
      }
    }

    after_dollar <- function(row) {
      siblings <- kids(row_of(parent[row]))
      at <- match(row, siblings)
      !is.na(at) && at > 1 && token[siblings[at - 1]] %in% c("'$'", "'@'")
    }
    symbols <- which(token == "SYMBOL")
    uses <- character(0)
    candidates <- character(0)
    for (row in symbols) {
      name <- text[row]
      if (after_dollar(row)) {
        candidates <- c(candidates, name)
        next
      }
      candidates <- c(candidates, name)
      if (!(row %in% plain_targets) && is_global(name)) {
        uses <- c(uses, name)
      }
    }
    for (row in which(token == "SYMBOL_FUNCTION_CALL")) {
      if (is_global(text[row]) && is.function(get0(text[row], envir = global, inherits = FALSE))) {
        uses <- c(uses, text[row])
      }
    }

    # Strings of assignments that make a frame without reading one: the
    # values of data.frame(arm = c("A", "B")) build the frame and name no
    # column the cell uses.
    made <- integer(0)
    for (assignment in assignments) {
      if (is.null(frames[[assignment$name]])) {
        next
      }
      inside <- below(assignment$value)
      if (!any(token[inside] == "SYMBOL" & text[inside] %in% names(frames))) {
        made <- c(made, inside[token[inside] == "STR_CONST"])
      }
    }
    for (row in which(token == "STR_CONST")) {
      if (!(row %in% made)) {
        candidates <- c(candidates, tryCatch(str2lang(text[row]), error = function(e) ""))
      }
    }
    used_frames <- intersect(unique(c(uses, defs)), names(frames))
    touched <- stats::setNames(list(), character(0))
    for (frame in used_frames) {
      columns <- sort(intersect(unique(candidates), frames[[frame]]), method = "radix")
      if (length(columns)) {
        touched[[frame]] <- as.list(columns)
      }
    }

    # Formulas, as written: y ~ x + (1 | g).
    formulas <- character(0)
    formula_rows <- integer(0)
    for (row in which(token == "'~'")) {
      at <- row_of(parent[row])
      up <- at
      nested <- FALSE
      while (!is.na(up) && parent[up] != 0) {
        up <- row_of(parent[up])
        if (!is.na(up) && up %in% formula_rows) {
          nested <- TRUE
          break
        }
      }
      formula_rows <- c(formula_rows, at)
      written <- node_text(at)
      if (!nested && nchar(written) < 300) {
        formulas <- c(formulas, written)
      }
    }
    is_formula <- function(row) {
      !is.na(row) && any(token[kids(row)] == "'~'")
    }

    # A value written in the cell, as R code, or NA: a number, a string, a
    # flag, a negative number, or c() of at most 8 numbers.
    literal_of <- function(row) {
      if (is.na(row) || token[row] != "expr") {
        return(NA_character_)
      }
      found <- kids(row)
      if (length(found) == 1) {
        one <- found[1]
        if (token[one] == "STR_CONST") {
          return(text[one])
        }
        if (token[one] == "NUM_CONST" && !(text[one] %in% c("NA", "NA_integer_", "NA_real_", "NA_character_", "NULL", "NaN"))) {
          return(text[one])
        }
        return(NA_character_)
      }
      if (length(found) == 2 && token[found[1]] == "'-'") {
        number <- only(found[2])
        if (!is.na(number) && token[number] == "NUM_CONST" && !(text[number] %in% c("TRUE", "FALSE", "NA", "NULL"))) {
          return(node_text(row))
        }
        return(NA_character_)
      }
      head <- found[1]
      if (length(found) >= 4 && token[head] == "expr" && token[found[2]] == "'('") {
        name <- kids(head)
        if (length(name) == 1 && token[name] == "SYMBOL_FUNCTION_CALL" && text[name] == "c") {
          values <- found[token[found] == "expr"][-1]
          if (length(values) >= 1 && length(values) <= 8 && !any(token[found] %in% c("SYMBOL_SUB", "EQ_SUB")) &&
            all(vapply(values, function(value) {
              written <- literal_of(value)
              !is.na(written) && !grepl("^[\"']", written) && !(written %in% c("TRUE", "FALSE"))
            }, logical(1)))) {
            return(node_text(row))
          }
        }
      }
      NA_character_
    }

    decisions <- list()
    attachments <- list()
    seen <- character(0)
    short <- function(fn) {
      if (is.na(fn)) "" else sub("^.*::", "", fn)
    }
    same <- function(a, b) identical(if (is.null(a)) NA else a, if (is.null(b)) NA else b)
    # Add a decision of a call, keyed by the call, or of an assignment, keyed by its name.
    add <- function(entry, call = NULL, at = 0) {
      key <- paste(entry$name, if (is.null(call)) "" else paste(call$line, call$col))
      if (key %in% seen || looks_secret(entry$name, entry$value)) {
        return(invisible())
      }
      seen <<- c(seen, key)
      if (!is.null(call)) {
        for (index in seq_along(decisions)) {
          other <- decisions[[index]]
          if (!is.null(other$calls) && identical(other$name, entry$name) && identical(other$value, entry$value) &&
            identical(other$provenance, entry$provenance) && same(other$param, entry$param) &&
            short(other$`function`) == short(entry$`function`)) {
            decisions[[index]]$calls[[length(other$calls) + 1]] <<- call
            return(invisible())
          }
        }
        entry$calls <- list(call)
      }
      entry$.at <- at
      decisions[[length(decisions) + 1]] <<- entry
    }

    # The arguments of a call: each with its name, or NA, and the row of its value.
    arguments_of <- function(call_row) {
      found <- kids(call_row)
      opened <- match("'('", token[found])
      found <- if (length(found) - 1 >= opened + 1) found[(opened + 1):(length(found) - 1)] else integer(0)
      groups <- list()
      current <- integer(0)
      for (row in found) {
        if (token[row] == "','") {
          groups[[length(groups) + 1]] <- current
          current <- integer(0)
        } else {
          current <- c(current, row)
        }
      }
      groups[[length(groups) + 1]] <- current
      result <- list()
      for (group in groups) {
        if (!length(group)) {
          next
        }
        if (length(group) >= 2 && token[group[2]] == "EQ_SUB") {
          name <- text[group[1]]
          if (token[group[1]] == "STR_CONST") name <- str2lang(name)
          result[[length(result) + 1]] <- list(name = name, value = if (length(group) >= 3) group[3] else NA_integer_)
        } else {
          result[[length(result) + 1]] <- list(name = NA_character_, value = group[1])
        }
      }
      result
    }

    # The formals that each argument binds to, as R matches them: by exact
    # name, by a unique start of a name before `...`, then by position. An
    # argument that binds to none keeps its own name, or NA.
    bind <- function(arguments, params, extra) {
      named <- vapply(arguments, function(arg) arg$name, character(1))
      out <- rep(NA_character_, length(arguments))
      open <- before_dots(params)
      exact <- setdiff(c(params, extra), "...")
      used <- character(0)
      for (index in seq_along(arguments)) {
        if (!is.na(named[index]) && named[index] %in% exact && !(named[index] %in% used)) {
          out[index] <- named[index]
          used <- c(used, named[index])
        }
      }
      for (index in seq_along(arguments)) {
        if (!is.na(named[index]) && is.na(out[index])) {
          left <- setdiff(c(open, extra), used)
          hit <- left[startsWith(left, named[index])]
          out[index] <- if (length(hit) == 1) hit else named[index]
          used <- c(used, out[index])
        }
      }
      free <- setdiff(open, used)
      for (index in seq_along(arguments)) {
        if (is.na(named[index]) && length(free)) {
          out[index] <- free[1]
          free <- free[-1]
        }
      }
      out
    }

    # The class of the object that an argument names in the global environment, or NULL.
    object_of <- function(row) {
      name <- if (is.na(row)) NA_character_ else symbol_of(row)
      if (is.na(name) || !is_global(name)) NULL else get0(name, envir = global, inherits = FALSE)
    }

    signatures <- list()
    for (row in which(token == "SYMBOL_FUNCTION_CALL")) {
      name <- text[row]
      head <- row_of(parent[row])
      call_row <- row_of(parent[head])
      if (is.na(call_row) || name %in% skipped_functions) {
        next
      }
      parts <- kids(call_row)
      if (length(parts) < 3 || parts[1] != head || token[parts[2]] != "'('") {
        next
      }
      head_parts <- kids(head)
      if (any(token[head_parts] %in% c("'$'", "'@'"))) {
        # A method of an object, obj$fit(): the kernel cannot tell the function.
        next
      }
      package <- if (any(token[head_parts] == "SYMBOL_PACKAGE")) text[head_parts[token[head_parts] == "SYMBOL_PACKAGE"][1]] else NA_character_
      arguments <- arguments_of(call_row)
      # A pipe gives the call its first argument, or the argument that holds its placeholder.
      outer <- row_of(parent[call_row])
      if (!is.na(outer)) {
        around <- kids(outer)
        if (length(around) == 3 && around[3] == call_row && (token[around[2]] == "PIPE" || (token[around[2]] == "SPECIAL" && text[around[2]] == "%>%"))) {
          holder <- vapply(arguments, function(arg) {
            one <- only(arg$value)
            !is.na(one) && (token[one] == "PLACEHOLDER" || (token[one] == "SYMBOL" && text[one] == "."))
          }, logical(1))
          if (any(holder)) {
            arguments[[which(holder)[1]]]$value <- around[1]
          } else {
            arguments <- c(list(list(name = NA_character_, value = around[1])), arguments)
          }
        }
      }
      unpacks <- any(vapply(arguments, function(arg) {
        one <- only(arg$value)
        !is.na(one) && token[one] == "SYMBOL" && text[one] == "..."
      }, logical(1)))

      fn <- resolve(name, package)
      own <- !is.null(fn) && identical(environment(fn), global)
      from <- if (is.null(fn) || own) NA_character_ else package_of(fn)
      entry <- known[[name]]
      if (!is.null(entry) && ((!is.na(package) && !(package %in% c(entry$package, entry$also))) ||
        (!is.null(fn) && !(from %in% c(entry$package, entry$also))))) {
        entry <- NULL
      }
      positional <- sum(vapply(arguments, function(arg) is.na(arg$name), logical(1)))
      first <- if (length(arguments)) arguments[[1]]$value else NA_integer_
      # The formals, of the S3 method that the first argument picks for a generic.
      params <- NULL
      extra <- character(0)
      method <- fn
      method_name <- name
      forwarded <- list()
      if (!is.null(fn)) {
        if (!is.primitive(fn) && "UseMethod" %in% all.names(body(fn))) {
          object <- object_of(first)
          # .class2 gives the classes that S3 dispatch reads, since R 4.0.0.
          dispatch <- get0(".class2", envir = baseenv(), mode = "function", ifnotfound = class)
          classes <- if (is_formula(first)) "formula" else if (!is.null(object)) dispatch(object) else character(0)
          for (class in c(classes, "default")) {
            found <- utils::getS3method(name, class, optional = TRUE, envir = global)
            if (!is.null(found)) {
              method <- found
              method_name <- paste(name, class, sep = ".")
              if (class == "formula") {
                fallback <- utils::getS3method(name, "default", optional = TRUE, envir = global)
                if (!is.null(fallback)) forwarded <- list(fallback)
              }
              break
            }
          }
        }
        params <- names(formals_of(method))
        if (!is.na(forwards[name]) && !is.na(from) && from == "utils") {
          passed_to <- get0(forwards[[name]], envir = asNamespace("utils"), inherits = FALSE)
          if (is.function(passed_to)) forwarded <- list(passed_to)
        }
        for (other in forwarded) extra <- c(extra, before_dots(names(formals_of(other))))
      } else if (!is.null(entry)) {
        params <- entry$params
      }
      bound <- bind(arguments, params, extra)
      passed <- bound[!is.na(bound)]
      value_of <- function(param) {
        at <- match(param, bound)
        if (is.na(at)) NA_integer_ else arguments[[at]]$value
      }

      line <- pd$line1[row]
      col <- byte_col(line, pd$col1[row])
      file_param <- if (reader(name) && length(params) && !is.na(params[1])) params[1] else NA_character_
      # The frame the call joins, the file it reads without its extension, or the first frame it works on.
      target <- NA_character_
      if (name == "merge") {
        joined <- root_of(value_of("y"))
        if (!is.na(joined) && (!is.null(frames[[joined]]) || !is_global(joined))) target <- joined
      }
      if (is.na(target) && !is.na(file_param)) {
        written <- literal_of(value_of(file_param))
        if (!is.na(written) && grepl("^[\"']", written)) {
          target <- sub("\\.[^.]*$", "", basename(str2lang(written)))
          if (!nzchar(target)) target <- NA_character_
        }
      }
      if (is.na(target)) {
        for (arg in arguments) {
          inside <- if (is.na(arg$value)) integer(0) else c(arg$value, below(arg$value))
          hits <- inside[token[inside] == "SYMBOL" & text[inside] %in% names(frames)]
          if (length(hits)) {
            target <- text[hits[1]]
            break
          }
        }
      }
      call <- list(line = line, col = col, target = target)
      at <- line * 1e6 + col
      shown_name <- if (!is.na(from)) paste0(from, "::", name) else if (!is.na(package)) paste0(package, "::", name) else if (!is.null(entry)) paste0(entry$package, "::", name) else name

      if (!is.null(entry) && !unpacks) {
        # Whether a factor, a text or a flag is among the variables of the
        # model, in its data or else in the frame of the kernel that holds
        # them all, as a frame that a function passes on: the coding of
        # factors changes nothing in a model of numbers alone, and nothing
        # is known before the frame exists.
        model_formula <- value_of(if ("formula" %in% bound) "formula" else bound[1])
        data_name <- if (is.na(value_of("data"))) NA_character_ else root_of(value_of("data"))
        factors <- FALSE
        if (is_formula(model_formula)) {
          variables <- all.vars(str2lang(node_text(model_formula)))
          holder <- if (!is.na(data_name) && !is.null(frames[[data_name]])) {
            data_name
          } else {
            holding <- names(frames)[vapply(frames, function(columns) all(variables %in% columns), logical(1))]
            if (length(holding)) holding[1] else NA_character_
          }
          if (!is.na(holder)) {
            frame <- get0(holder, envir = global, inherits = FALSE)
            factors <- any(vapply(intersect(variables, names(frame)), function(column) {
              values <- frame[[column]]
              is.factor(values) || is.character(values) || is.logical(values)
            }, logical(1)))
          }
        }
        paired <- value_of("paired")
        call_facts <- list(
          passed = passed,
          positional = positional,
          factors = factors,
          object = object_of(first),
          two_samples = (is_formula(first) || positional >= 2 || "y" %in% passed) &&
            !identical(literal_of(paired), "TRUE")
        )
        for (param in names(entry$defaults)) {
          default <- entry$defaults[[param]]
          own_param <- if (is.null(default$param)) param else default$param
          if ((!is.na(own_param) && own_param %in% passed) || !isTRUE(default$when(call_facts))) {
            next
          }
          version <- version_of(entry$package)
          add(c(list(
            name = param, value = default$value, provenance = "library_default",
            param = own_param, `function` = paste0(entry$package, "::", name), note = default$note,
            library = entry$package
          ), if (!is.na(version)) list(version = version)), call, at)
        }
      }

      # A function of the analyst's own file: each formal that the call
      # leaves at its default, and the constant of the file that the default
      # names, as the Python version shows the defaults of the analyst's
      # modules.
      path <- if (own && !unpacks) file_of(fn) else NA_character_
      if (!is.na(path)) {
        relative <- substring(path, nchar(folder) + 2)
        defaults <- formals(fn)
        highlight <- NULL
        left <- FALSE
        for (param in names(defaults)) {
          if (param == "..." || param %in% passed || identical(defaults[[param]], quote(expr = ))) {
            next
          }
          left <- TRUE
          value <- defaults[[param]]
          constant <- if (is.symbol(value)) as.character(value) else NA_character_
          held <- if (is.na(constant)) NULL else get0(constant, envir = environment(fn))
          if (is.atomic(held) && length(held) == 1) {
            found <- line_of(path, constant)
            if (is.null(highlight) && !is.na(found$line)) {
              highlight <- found
            }
            add(list(
              name = constant, value = paste(deparse(held), collapse = " "), provenance = "defaulted",
              param = param, `function` = name, source = list(file = relative, line = found$line)
            ), call, at)
          } else {
            add(list(
              name = param, value = paste(deparse(value, width.cutoff = 500L), collapse = " "), provenance = "defaulted",
              param = param, `function` = name, source = list(file = relative, line = NA)
            ), call, at)
          }
        }
        symbols_attached <- vapply(attachments, function(attachment) attachment$symbol, character(1))
        if (left && !(name %in% symbols_attached)) {
          attachment <- attachment_for(fn, path, relative, name, highlight)
          if (!is.null(attachment)) {
            attachments[[length(attachments) + 1]] <- attachment
          }
        }
      }

      if (read_signatures && !is.null(fn) && !own && !unpacks && !is.primitive(method) &&
        isNamespace(environment(method))) {
        method_package <- package_of(method)
        key <- paste0(method_package, "::", method_name)
        read <- signature_of(key, shown_name, method_package, method, forwarded)
        defaulted <- vapply(read$params, function(item) item$name, character(1))
        defaulted <- defaulted[!(defaulted %in% passed)]
        if (length(defaulted)) {
          if (is.null(signatures[[key]])) signatures[[key]] <- read
          signatures[[key]]$calls[[length(signatures[[key]]$calls) + 1]] <- c(call, list(defaulted = as.list(defaulted)))
        }
      }

      for (index in seq_along(arguments)) {
        param <- bound[index]
        if (is.na(param) || (param %in% skipped_params && !identical(param, file_param))) {
          next
        }
        value_row <- arguments[[index]]$value
        written <- literal_of(value_row)
        if (is.na(written) && param == "family") {
          # glm(family = binomial) chooses the model as much as a literal does.
          one <- only(value_row)
          head_name <- if (!is.na(one) && token[one] == "SYMBOL") text[one] else {
            parts_of <- kids(value_row)
            call_head <- if (length(parts_of)) kids(parts_of[1]) else integer(0)
            if (length(call_head) == 1 && token[call_head] == "SYMBOL_FUNCTION_CALL") text[call_head] else NA_character_
          }
          if (!is.na(head_name) && head_name %in% family_functions) {
            written <- node_text(value_row)
          }
        }
        if (is.na(written)) {
          next
        }
        if (grepl("^[\"']", written)) {
          value <- tryCatch(str2lang(written), error = function(e) "")
          if (is_global(value) || any(vapply(frames, function(columns) value %in% columns, logical(1)))) {
            next
          }
        }
        add(list(name = param, value = written, provenance = "literal", param = param, `function` = shown_name), call, at)
      }
    }

    # Constants assigned at the top level: MIN_DAYS <- 14.
    for (assignment in assignments) {
      if (!assignment$top || !assignment$plain) {
        next
      }
      written <- literal_of(assignment$value)
      if (!is.na(written)) {
        add(list(name = assignment$name, value = written, provenance = "literal", param = NA_character_, `function` = NA_character_),
          at = pd$line1[assignment$row] * 1e6 + byte_col(pd$line1[assignment$row], pd$col1[assignment$row])
        )
      }
    }

    ranks <- c(defaulted = 0, library_default = 1, literal = 2)
    if (length(decisions)) {
      rank <- vapply(decisions, function(decision) ranks[[decision$provenance]] * 1e12 + decision$.at, numeric(1))
      decisions <- decisions[order(rank)]
    }
    decisions <- lapply(decisions, function(decision) {
      decision$.at <- NULL
      if (!is.null(decision$calls)) {
        places <- vapply(decision$calls, function(call) call$line * 1e6 + call$col, numeric(1))
        decision$calls <- decision$calls[order(places)]
      }
      decision
    })
    result <- list(
      defs = as.list(sort(unique(defs), method = "radix")),
      uses = as.list(sort(unique(uses), method = "radix")),
      formulas = as.list(unique(formulas)),
      columns = touched,
      decisions = utils::head(decisions, max_decisions),
      attachments = attachments
    )
    if (read_signatures) {
      listed <- unname(signatures)
      if (length(listed)) {
        firsts <- vapply(listed, function(entry) entry$calls[[1]]$line * 1e6 + entry$calls[[1]]$col, numeric(1))
        listed <- listed[order(firsts)]
      }
      result$signatures <- utils::head(listed, max_signatures)
    }
    result
  }

  results <- list()
  for (cell in args$cells) {
    results[[cell$id]] <- tryCatch(analyze(cell$source), error = function(e) {
      list(
        defs = list(), uses = list(), formulas = list(),
        columns = stats::setNames(list(), character(0)), decisions = list(), attachments = list(),
        error = conditionMessage(e)
      )
    })
  }
  if (!length(results)) {
    results <- stats::setNames(list(), character(0))
  }
  IRdisplay::publish_mimebundle(list(
    "application/vnd.whybook.result+json" = list(cells = results)
  ))
}
