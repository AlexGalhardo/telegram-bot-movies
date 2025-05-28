import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import TelegramBot, { Message } from "node-telegram-bot-api";

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TMDB_API_KEY = process.env.TMDB_API_KEY!;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

type Genre = {
	id: number;
	name: string;
};

type TMDBMovie = {
	id: number;
	title: string;
	overview: string;
	vote_average: number;
	release_date: string;
	poster_path: string;
	runtime: number;
	genre_ids: number[];
};

type SavedMovie = TMDBMovie & {
	saved_at: string;
};

type RecommendedMovie = {
	movie_id: number;
	user_id: number;
	recommended_at: string;
};

const _userStates = new Map<number, string>();
let genreMap: Record<string, number> = {};

const MOVIES_JSON_PATH = path.join(process.cwd(), "filmes.json");
const RECOMMENDED_JSON_PATH = path.join(process.cwd(), "recomendados.json");

let savedMovies: SavedMovie[] = [];
let recommendedMovies: RecommendedMovie[] = [];

async function loadJSONFiles() {
	try {
		try {
			const moviesData = await fs.readFile(MOVIES_JSON_PATH, "utf-8");
			savedMovies = JSON.parse(moviesData);
		} catch (_error) {
			console.log("Arquivo movies.json não encontrado, criando novo...");
			savedMovies = [];
			await saveMoviesToJSON();
		}

		try {
			const recommendedData = await fs.readFile(RECOMMENDED_JSON_PATH, "utf-8");
			recommendedMovies = JSON.parse(recommendedData);
		} catch (_error) {
			console.log("Arquivo recommended.json não encontrado, criando novo...");
			recommendedMovies = [];
			await saveRecommendedToJSON();
		}
	} catch (error) {
		console.error("Erro ao carregar arquivos JSON:", error);
	}
}

async function saveMoviesToJSON() {
	try {
		await fs.writeFile(MOVIES_JSON_PATH, JSON.stringify(savedMovies, null, 2));
	} catch (error) {
		console.error("Erro ao salvar movies.json:", error);
	}
}

async function saveRecommendedToJSON() {
	try {
		await fs.writeFile(RECOMMENDED_JSON_PATH, JSON.stringify(recommendedMovies, null, 2));
	} catch (error) {
		console.error("Erro ao salvar recommended.json:", error);
	}
}

async function fetchGenres(): Promise<Genre[]> {
	const res = await fetch(`https://api.themoviedb.org/3/genre/movie/list?language=pt-BR&api_key=${TMDB_API_KEY}`);
	const data = await res.json();
	return data.genres;
}

async function fetchMoviesByGenre(genreId: number, page = 1): Promise<TMDBMovie[]> {
	const res = await fetch(
		`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&with_genres=${genreId}&language=pt-BR&sort_by=vote_average.desc&vote_count.gte=500&page=${page}`,
	);
	const data = await res.json();

	const movies: TMDBMovie[] = await Promise.all(
		data.results.map(async (movie: any) => {
			const resDetail = await fetch(
				`https://api.themoviedb.org/3/movie/${movie.id}?api_key=${TMDB_API_KEY}&language=pt-BR`,
			);
			const detailData = await resDetail.json();
			return {
				...detailData,
				genre_ids: movie.genre_ids ?? [],
			};
		}),
	);

	return movies;
}

function isMovieAlreadySaved(movieId: number): boolean {
	return savedMovies.some((movie) => movie.id === movieId);
}

function isMovieAlreadyRecommended(movieId: number, userId: number): boolean {
	return recommendedMovies.some((rec) => rec.movie_id === movieId && rec.user_id === userId);
}

async function saveNewMovies(movies: TMDBMovie[]): Promise<void> {
	const newMovies: SavedMovie[] = [];

	for (const movie of movies) {
		if (!isMovieAlreadySaved(movie.id)) {
			newMovies.push({
				...movie,
				saved_at: new Date().toISOString(),
			});
		}
	}

	if (newMovies.length > 0) {
		savedMovies.push(...newMovies);
		await saveMoviesToJSON();
		console.log(`${newMovies.length} novos filmes salvos no JSON`);
	}
}

async function getAvailableMoviesForUser(genreId: number, userId: number): Promise<SavedMovie[]> {
	const availableMovies = savedMovies.filter(
		(movie) => movie.genre_ids.includes(genreId) && !isMovieAlreadyRecommended(movie.id, userId),
	);

	return availableMovies;
}

async function fetchMoreMoviesIfNeeded(genreId: number, userId: number): Promise<void> {
	const availableMovies = await getAvailableMoviesForUser(genreId, userId);

	if (availableMovies.length < 5) {
		console.log(`Poucos filmes disponíveis (${availableMovies.length}), buscando mais no TMDB...`);

		for (let page = 1; page <= 5; page++) {
			const newMovies = await fetchMoviesByGenre(genreId, page);
			await saveNewMovies(newMovies);

			const updatedAvailable = await getAvailableMoviesForUser(genreId, userId);
			if (updatedAvailable.length >= 10) break;
		}
	}
}

async function markMoviesAsRecommended(movieIds: number[], userId: number): Promise<void> {
	const newRecommendations: RecommendedMovie[] = movieIds.map((movieId) => ({
		movie_id: movieId,
		user_id: userId,
		recommended_at: new Date().toISOString(),
	}));

	recommendedMovies.push(...newRecommendations);
	await saveRecommendedToJSON();
}

async function sendMovieRecommendations(chatId: number, genreName: string) {
	const genreId = genreMap[genreName];
	if (!genreId) return bot.sendMessage(chatId, "Categoria inválida.");

	try {
		await fetchMoreMoviesIfNeeded(genreId, chatId);

		const availableMovies = await getAvailableMoviesForUser(genreId, chatId);

		if (availableMovies.length === 0) {
			return bot.sendMessage(
				chatId,
				`Desculpe, não encontrei novos filmes de ${genreName} para recomendar no momento.`,
			);
		}

		const selectedMovies = availableMovies
			.toSorted(() => Math.random() - 0.5)
			.slice(0, Math.min(3, availableMovies.length));

		await markMoviesAsRecommended(
			selectedMovies.map((m) => m.id),
			chatId,
		);

		for (const movie of selectedMovies) {
			const message = `🎬 *${movie.title}*\n\n📝 ${movie.overview || "Sem descrição"}\n⭐️ Nota: ${movie.vote_average}\n🕐 Duração: ${movie.runtime} min\n📅 Lançamento: ${movie.release_date}`;
			const photoUrl = `https://image.tmdb.org/t/p/w500${movie.poster_path}`;

			await bot.sendPhoto(chatId, photoUrl, {
				caption: message,
				parse_mode: "Markdown",
			});
		}

		console.log(`Recomendados ${selectedMovies.length} filmes para usuário ${chatId}`);
	} catch (error) {
		console.error("Erro ao enviar recomendações:", error);
		bot.sendMessage(chatId, "Ops! Ocorreu um erro ao buscar filmes. Tente novamente.");
	}
}

async function initGenres() {
	const genres = await fetchGenres();
	genreMap = Object.fromEntries(genres.map((g) => [g.name, g.id]));
}

async function initBot() {
	console.log("Iniciando bot...");
	await loadJSONFiles();
	await initGenres();
	console.log("Bot iniciado com sucesso!");
	console.log(`Filmes salvos: ${savedMovies.length}`);
	console.log(`Recomendações feitas: ${recommendedMovies.length}`);
}

bot.on("message", async (msg: Message) => {
	const chatId = msg.chat.id;
	const text = msg.text?.trim();

	const genreNames = Object.keys(genreMap);
	if (genreNames.length === 0) await initGenres();

	if (text && genreMap[text]) return;

	bot.sendMessage(chatId, "Qual categoria de filme você gostaria de receber 3 recomendações:", {
		reply_markup: {
			keyboard: genreNames.map((c) => [{ text: c }]),
			one_time_keyboard: true,
			resize_keyboard: true,
		},
	});
});

bot.on("text", async (msg) => {
	const chatId = msg.chat.id;
	const category = msg.text?.trim();

	if (category && genreMap[category]) {
		await sendMovieRecommendations(chatId, category);
	}
});

initBot().catch(console.error);
