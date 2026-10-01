# List the user's variables with what the Variables and Contents sections show.
#
# The R version of inspect_variables.py, for R kernels such as xeus-r and
# IRkernel. The frontend bundle holds the text of this file
# (scripts/embed-kernel-code.mjs), runs it in the global environment, calls
# the function with the JSON arguments and removes it again (the R adapter in
# src/model/languages.ts). It needs jsonlite and IRdisplay, which both kernels
# depend on. The result goes out as display data with a MIME type that output
# areas do not render.
#
# It lists data frames with their columns, vectors as series, scalars as
# constants, and matrices with their shape. It does not fingerprint frames,
# so `args$known` is not read and every listing describes every frame again,
# and it does not read fitted models.
.whybook_inspect_variables <- function(args) {
  max_columns <- if (is.null(args$max_columns)) 20000L else as.integer(args$max_columns)
  # Above this many values, distinct counts and ranges are skipped.
  detail_limit <- if (is.null(args$detail_limit)) 2e7 else as.numeric(args$detail_limit)

  # A key, a token or a password in a variable is listed with its length and
  # "secret": true, never its text: the view keeps the listing in the
  # notebook and sends it with every request to a model. The server, the
  # Python listing (inspect_variables.py), the analyses of cells and the view
  # hold the same rule (privacy.py says it in full,
  # tests/data/secret_names.json holds its cases): only a string is a secret,
  # when a part of its name says so, as the "token" of HF_TOKEN, or its text
  # holds a known prefix of a key or a long run of letters and digits.
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

  secret_string <- function(name, text) {
    if (secret_name(name)) {
      return(TRUE)
    }
    # The text of a string of up to 10,000 characters: a longer one is listed by its length alone.
    if (is.na(text) || nchar(text) > 10000) {
      return(FALSE)
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

  clean <- function(value) {
    if (inherits(value, c("Date", "POSIXt"))) {
      return(format(value))
    }
    if (is.numeric(value)) {
      if (is.na(value) || !is.finite(value)) {
        return(NULL)
      }
      if (value == round(value) && abs(value) < 2^31) {
        return(as.integer(value))
      }
      return(round(value, 4))
    }
    as.character(value)
  }

  column_tag <- function(label, x, n_unique, rows) {
    lowered <- tolower(label)
    if (is.logical(x)) {
      return("bool")
    }
    if (lowered == "id" || endsWith(lowered, "_id")) {
      return("id")
    }
    if (is.factor(x)) {
      return(if (is.ordered(x)) "ord" else "cat")
    }
    if (inherits(x, c("Date", "POSIXt"))) {
      return("date")
    }
    if (is.integer(x)) {
      return("int")
    }
    if (is.numeric(x)) {
      return("num")
    }
    if (is.character(x)) {
      if (!is.null(n_unique) && rows > 0 && n_unique > 50 && n_unique > 0.5 * rows) {
        return("text")
      }
      return("cat")
    }
    "other"
  }

  column_kind <- function(tag, n_unique) {
    if (tag == "bool" || (identical(n_unique, 2L) && tag %in% c("int", "num", "cat", "ord"))) {
      return("binary")
    }
    switch(tag,
      int = "numeric", num = "numeric", date = "datetime", cat = "categorical",
      ord = "categorical", id = "id", text = "text", "other"
    )
  }

  describe_column <- function(label, x, detailed) {
    rows <- length(x)
    missing <- sum(is.na(x))
    entry <- list(label = label, dtype = class(x)[1], missing = missing)
    n_unique <- NULL
    if (detailed && is.atomic(x)) {
      n_unique <- length(unique(x[!is.na(x)]))
    }
    tag <- column_tag(label, x, n_unique, rows)
    entry$tag <- tag
    entry$kind <- column_kind(tag, n_unique)
    if (!is.null(n_unique)) {
      entry$unique <- n_unique
    }
    if (detailed && tag %in% c("int", "num", "date") && missing < rows) {
      entry$min <- clean(min(x, na.rm = TRUE))
      entry$max <- clean(max(x, na.rm = TRUE))
    }
    # Levels of a factor, a text or a flag; numbers show their range instead.
    if (!is.null(n_unique) && n_unique <= 6 && (is.factor(x) || is.character(x) || is.logical(x))) {
      values <- if (is.factor(x)) levels(x) else sort(unique(as.character(x[!is.na(x)])))
      # A list stays a JSON array when it holds one level.
      entry$levels <- as.list(utils::head(as.character(values), 6))
    }
    entry
  }

  describe_frame <- function(name, value) {
    rows <- nrow(value)
    labels <- utils::head(names(value), max_columns)
    detailed <- as.numeric(rows) * length(labels) <= detail_limit
    columns <- lapply(labels, function(label) {
      tryCatch(
        describe_column(label, value[[label]], detailed),
        error = function(e) {
          list(label = label, tag = "other", kind = "other", error = conditionMessage(e))
        }
      )
    })
    list(
      name = name, label = name, kind = "dataframe", type = class(value)[1],
      rows = rows, n_columns = ncol(value), columns = columns
    )
  }

  describe <- function(name, value) {
    type <- class(value)[1]
    if (is.data.frame(value)) {
      return(describe_frame(name, value))
    }
    if (is.atomic(value) && is.null(dim(value)) && length(value) == 1 && !is.factor(value)) {
      if (is.character(value) && secret_string(name, value)) {
        return(list(name = name, label = name, kind = "constant", type = type, secret = TRUE, length = nchar(value)))
      }
      text <- paste(deparse(value), collapse = "")
      if ((!is.character(value) || nchar(value) <= 58) && nchar(text) <= 60) {
        return(list(name = name, label = name, kind = "constant", type = type, value = text))
      }
      if (is.character(value)) {
        # A long text is listed by its length, as the Python listing lists it.
        return(list(name = name, label = name, kind = "other", type = type, length = nchar(value)))
      }
    }
    if (!is.null(dim(value))) {
      return(list(
        name = name, label = name, kind = "array", type = type,
        shape = as.list(dim(value)), dtype = typeof(value)
      ))
    }
    if (is.atomic(value)) {
      # A vector is described as a column of its own, as a pandas Series is.
      entry <- describe_column(name, value, length(value) <= detail_limit)
      entry$name <- name
      entry$type <- type
      entry$rows <- length(value)
      return(entry)
    }
    list(name = name, label = name, kind = "other", type = type, length = length(value))
  }

  variables <- list()
  # ls() leaves out names that start with a dot, as this function's own name does.
  for (name in ls(envir = globalenv())) {
    value <- get(name, envir = globalenv())
    if (is.function(value) || is.environment(value)) {
      next
    }
    variables[[length(variables) + 1]] <- tryCatch(
      describe(name, value),
      error = function(e) {
        list(name = name, label = name, kind = "other", type = class(value)[1], error = conditionMessage(e))
      }
    )
  }

  base <- c("stats", "graphics", "grDevices", "utils", "datasets", "methods", "base")
  attached <- setdiff(.packages(), base)
  packages <- stats::setNames(
    lapply(attached, function(package) as.character(utils::packageVersion(package))),
    attached
  )

  IRdisplay::publish_mimebundle(list(
    "application/vnd.whybook.result+json" = list(
      variables = variables,
      packages = packages,
      language = paste("R", getRversion()),
      cwd = normalizePath(getwd())
    )
  ))
}
